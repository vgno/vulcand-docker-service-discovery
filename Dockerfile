FROM node:5
MAINTAINER Sindre Gulseth <sindre.gulseth@vg.no>

RUN mkdir /app
WORKDIR /app

# Install deps
ADD package.json /app/package.json
RUN npm install

ADD . /app

CMD ["node", "index.js"]