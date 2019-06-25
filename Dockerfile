FROM node:carbon-alpine as builder

WORKDIR /bot/prlint

RUN apk add --no-cache --virtual .gyp python make g++

COPY ./package*.json ./

COPY ./yarn.lock ./

RUN yarn install


FROM node:carbon-alpine as runner

WORKDIR /bot/prlint

COPY --from=builder /bot/prlint/node_modules/ ./node_modules/

COPY src src

COPY ./package*.json ./

EXPOSE 3000

ENTRYPOINT [ "npm", "start" ]

## MUST mount a .env file at path /bot/prlint/.env
