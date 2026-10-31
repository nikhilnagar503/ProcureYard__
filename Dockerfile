FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
COPY data/ ./data/
RUN npm run build

EXPOSE 8000

CMD ["npm", "start"]
