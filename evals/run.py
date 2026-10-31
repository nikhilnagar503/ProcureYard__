#!/usr/bin/env python3
"""Black-box conversation evaluator. It calls only the service and PaySwift HTTP APIs."""

from __future__ import annotations

import json
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONVERSATIONS = ROOT / "data" / "conversations.json"


class EvalError(RuntimeError):
    pass


def request_json(url: str, method: str = "GET", body: Any = None, timeout: float = 20) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    request = Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode())
        except HTTPError as exc:
            text = exc.read().decode(errors="replace")
            if exc.code in {429, 503} and attempt < 3:
                # /messages is idempotent by message_id, so retrying the same
                # request is safe after temporary provider throttling.
                retry_after = exc.headers.get("Retry-After")
                try:
                    delay = float(retry_after) if retry_after else 15.0 * (2 ** attempt)
                except ValueError:
                    delay = 12.0
                time.sleep(min(max(delay, 1.0), 30.0))
                continue
            raise EvalError(f"HTTP {exc.code} from {url}: {text[:400]}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            if attempt < 3:
                time.sleep(2 * (attempt + 1))
                continue
            raise EvalError(f"Could not reach {url}: {exc}") from exc
    raise EvalError(f"Retry budget exhausted for {url}")


def payouts_for(base: str, rider_id: str) -> list[dict[str, Any]]:
    from urllib.parse import quote
    result = request_json(f"{base}/v1/payouts?rider_id={quote(rider_id)}")
    if isinstance(result, list):
        return result
    if isinstance(result, dict):
        rows = result.get("data", result.get("payouts"))
        if isinstance(rows, list):
            return rows
    raise EvalError("PaySwift ledger response did not contain a payout list")


def amounts_by_id(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {str(row.get("payout_id", row.get("id", ""))): int(row.get("amount", row.get("amount_rupees", 0))) for row in rows}


def new_ops(base: str, rider_id: str, before: set[str]) -> list[dict[str, Any]]:
    rows = request_json(f"{base}/ops/pending")
    if not isinstance(rows, list):
        raise EvalError("/ops/pending did not return a JSON list")
    return [row for row in rows if row.get("rider_id") == rider_id and str(row.get("id")) not in before]


def fresh_id(scenario_id: str, source: str) -> str:
    return f"eval-{scenario_id}-{source}-{uuid.uuid4().hex[:8]}"


def expected_options(expected: dict[str, Any]) -> list[dict[str, Any]]:
    return expected.get("one_of") or [expected]


def run_case(index: int, case: dict[str, Any], api: str, payswift: str) -> dict[str, Any]:
    scenario_id = f"{index:02d}-{uuid.uuid4().hex[:6]}"
    rider = case["rider_id"]
    before_payouts = amounts_by_id(payouts_for(payswift, rider))
    pending = request_json(f"{api}/ops/pending")
    before_ops = {str(row.get("id")) for row in pending if row.get("rider_id") == rider}
    replies: list[str] = []
    replies_by_source_id: dict[str, str] = {}
    message_ids: dict[str, str] = {}
    duplicate_ok = True
    trace: list[dict[str, Any]] = []
    error: str | None = None

    try:
        for turn in case.get("turns", []):
            if turn.get("from") != "rider":
                continue
            original_id = str(turn["message_id"])
            message_id = message_ids.setdefault(original_id, fresh_id(scenario_id, original_id[-8:]))
            payload = {"message_id": message_id, "rider_id": rider, "text": turn["text"], "received_at": turn["received_at"]}
            response = request_json(f"{api}/messages", "POST", payload, timeout=120)
            reply = str(response.get("reply", ""))
            if not reply:
                raise EvalError(f"message {original_id} returned no reply")
            replies.append(reply)
            replies_by_source_id.setdefault(original_id, reply)
        # Replay each repeated source message exactly as delivered, to verify saved-reply idempotency.
        seen: set[str] = set()
        for turn in case.get("turns", []):
            if turn.get("from") != "rider":
                continue
            original_id = str(turn["message_id"])
            if original_id in seen:
                payload = {"message_id": message_ids[original_id], "rider_id": rider, "text": turn["text"], "received_at": turn["received_at"]}
                replay = request_json(f"{api}/messages", "POST", payload, timeout=120)
                duplicate_ok = str(replay.get("reply", "")) == replies_by_source_id[original_id]
            seen.add(original_id)
    except (EvalError, KeyError, TypeError, ValueError) as exc:
        error = str(exc)

    created_payouts: dict[str, int] = {}
    created_ops: list[dict[str, Any]] = []
    try:
        after_payouts = amounts_by_id(payouts_for(payswift, rider))
        created_payouts = {key: amount for key, amount in after_payouts.items() if key not in before_payouts}
        created_ops = new_ops(api, rider, before_ops)
        trace = request_json(f"{api}/trace/{rider}")
    except (EvalError, KeyError, TypeError, ValueError) as exc:
        error = f"{error}; unable to collect final observations: {exc}" if error else str(exc)
        trace = []

    payout_amount = sum(created_payouts.values())
    approval_amount = sum(int(row.get("amount") or 0) for row in created_ops if row.get("type") == "approval")
    escalation_count = sum(1 for row in created_ops if row.get("type") == "escalation")
    reply_text = "\n".join(replies).lower()
    mentions = case.get("expected", {}).get("reply_mentions", [])
    mention_failures = [str(word) for word in mentions if str(word).lower() not in reply_text]
    trace_times = [str(event.get("at", "")) for event in trace if event.get("at")]
    trace_ordered = trace_times == sorted(trace_times)
    observed = {"payout": payout_amount, "approval": approval_amount or None, "escalations": escalation_count,
                "new_payouts": created_payouts, "new_ops_ids": [row.get("id") for row in created_ops],
                "duplicate_replay_same_reply": duplicate_ok, "trace_ordered": trace_ordered}
    failures: list[str] = []
    if error:
        failures.append(error)
    expected = case.get("expected", {})
    accepted = False
    for option in expected_options(expected):
        if option.get("payout", 0) != payout_amount:
            continue
        if option.get("approval") != (approval_amount or None):
            continue
        accepted = True
        break
    if not accepted:
        failures.append(f"expected one of {expected_options(expected)}; observed payout={payout_amount}, approval={approval_amount or None}")
    escalation_rule = expected.get("escalation", "optional")
    if escalation_rule == "no" and escalation_count:
        failures.append(f"unexpected {escalation_count} escalation(s)")
    if escalation_rule == "required" and not escalation_count:
        failures.append("expected an escalation, but none was created")
    if mention_failures:
        failures.append(f"reply omitted expected text: {mention_failures}")
    if not duplicate_ok:
        failures.append("duplicate message did not return the same saved reply")
    if not trace_ordered:
        failures.append("trace timestamps are not chronological")
    return {"scenario": case.get("scenario", f"case {index}"), "rider_id": rider,
            "status": "PASS" if not failures else "FAIL", "observed": observed,
            "replies": replies, "failures": failures}


def compose(*args: str) -> None:
    subprocess.run(["docker", "compose", *args], cwd=ROOT, check=True)


def wait_for_stack(api: str, payswift: str) -> None:
    for _ in range(60):
        try:
            request_json(f"{api}/health", timeout=3)
            request_json(f"{payswift}/health", timeout=3)
            return
        except EvalError:
            time.sleep(2)
    raise EvalError("Fresh app/PaySwift stack did not become healthy within 120 seconds")


def run_isolated_cases(selected_cases: list[tuple[int, dict[str, Any]]], api: str, payswift: str) -> list[dict[str, Any]]:
    """Run each conversation against fresh local Postgres and PaySwift state."""
    parsed = urlparse(api)
    if parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.port not in {None, 8000}:
        raise EvalError("Isolated mode manages this repository's Compose stack; use http://localhost:8000")
    results: list[dict[str, Any]] = []
    try:
        for case_index, (index, case) in enumerate(selected_cases):
            if case_index:
                time.sleep(15)
            compose("down", "--volumes", "--remove-orphans")
            up_args = ["up", "--detach"]
            if case_index == 0:
                up_args.append("--build")
            compose(*up_args)
            wait_for_stack(api, payswift)
            results.append(run_case(index, case, api, payswift))
            print(f"Case {index:02d}/24: {results[-1]['status']} — {case.get('scenario', 'conversation')}", flush=True)
    finally:
        compose("down", "--volumes", "--remove-orphans")
    return results


def main() -> int:
    if len(sys.argv) not in {2, 4} or (len(sys.argv) == 4 and sys.argv[2] != "--case"):
        print("Usage: python3 evals/run.py <service-url> [--case 1-24]", file=sys.stderr)
        return 2
    api = sys.argv[1].rstrip("/")
    parsed = urlparse(api)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        print("Service URL must include http:// or https://", file=sys.stderr)
        return 2
    payswift = f"{parsed.scheme}://{parsed.hostname}:8081"
    cases = json.loads(CONVERSATIONS.read_text())
    if not isinstance(cases, list) or len(cases) != 24:
        print(f"Expected 24 supplied conversations, found {len(cases) if isinstance(cases, list) else 'invalid data'}", file=sys.stderr)
        return 2
    if len(sys.argv) == 4:
        try:
            case_number = int(sys.argv[3])
        except ValueError:
            print("--case must be an integer from 1 to 24", file=sys.stderr)
            return 2
        if case_number < 1 or case_number > len(cases):
            print("--case must be an integer from 1 to 24", file=sys.stderr)
            return 2
        selected_cases = [(case_number, cases[case_number - 1])]
        isolated = False
        try:
            request_json(f"{api}/health")
            request_json(f"{payswift}/health")
        except EvalError as exc:
            print(f"Evaluator could not start: {exc}", file=sys.stderr)
            return 2
    else:
        selected_cases = list(enumerate(cases, 1))
        isolated = True
        print("Running all 24 cases in isolation. This clears local Postgres and PaySwift state before each case, rebuilds on the first case, and stops the Compose stack at the end.", flush=True)
    try:
        if isolated:
            results = run_isolated_cases(selected_cases, api, payswift)
        else:
            results = [run_case(index, case, api, payswift) for index, case in selected_cases]
    except (EvalError, subprocess.CalledProcessError, FileNotFoundError) as exc:
        print(f"Evaluator could not complete: {exc}", file=sys.stderr)
        return 2
    passed = sum(row["status"] == "PASS" for row in results)
    print(f"\nEvaluation: {passed}/{len(results)} passed; {len(results)-passed} failed")
    for index, row in enumerate(results, 1):
        observed = row["observed"]
        result = f"{index:02d} {row['status']} | {row['rider_id']} | payout ₹{observed['payout']} | approval {observed['approval']} | escalations {observed['escalations']} | {row['scenario']}"
        print(result)
        for failure in row["failures"]:
            print(f"   - {failure}")
    report_path = Path("eval-results.json")
    report_path.write_text(json.dumps({
        "run_at": datetime.now(timezone.utc).isoformat(),
        "service_url": api,
        "fresh_service_required_per_conversation": True,
        "isolated_service_per_conversation": isolated,
        "case_numbers": [index for index, _ in selected_cases],
        "case_cooldown_seconds": 15,
        "passed": passed,
        "total": len(results),
        "results": results,
    }, ensure_ascii=False, indent=2) + "\n")
    print(f"\nFull JSON report: {report_path.resolve()}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
