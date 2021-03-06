'use strict';

const assert = require('assert');
const express = require('express');
const bodyParser = require('body-parser');
const Promise = require('bluebird');
const EventEmitter = require('events');
const shutdown = require('http-shutdown');
const http = require('http');
const ramda = require('ramda');

const debug = require('debug')('TelegramServer:server');
const debugStorage = require('debug')('TelegramServer:storage');
const sendResult = require('./modules/sendResult.js');
const TelegramClient = require('./modules/telegramClient.js');
const requestLogger = require('./modules/requestLogger.js');
const Routes = require('./routes/index');

class TelegramServer extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = ramda.clone(config);
    this.config.port = this.config.port || 9000;
    this.config.host = this.config.host || 'localhost';
    this.ApiURL = `http://${this.config.host}:${this.config.port}`;
    this.config.storage = this.config.storage || 'RAM';
    this.config.storeTimeout = this.config.storeTimeout || 60; // store for a minute
    this.config.storeTimeout *= 1000;
    debug(`Telegram API server config: ${JSON.stringify(this.config)}`);

    this.updateId = 1;
    this.messageId = 1;
    this.webServer = express();
    this.webServer.use(sendResult);
    this.webServer.use(bodyParser.json());
    this.webServer.use(bodyParser.urlencoded({extended: true}));
    this.webServer.use(express.static('public'));
    this.webServer.use(requestLogger);

    if (this.config.storage === 'RAM') {
      this.storage = {
        userMessages: [],
        botMessages: [],
      };
    }
    this.started = false;
  }

  getClient(botToken, options) {
    // console.log(this);
    return new TelegramClient(this.ApiURL, botToken, options);
  }

  addBotMessage(message, botToken) {
    const d = new Date();
    const millis = d.getTime();
    const add = {
      time: millis,
      botToken,
      message,
      updateId: this.updateId,
      messageId: this.messageId,
      isRead: false,
    };
    this.storage.botMessages.push(add);
    this.messageId++;
    this.updateId++;
    this.emit('AddedBotMessage');
  }

  waitBotMessage() {
    return new Promise(resolve => this.on('AddedBotMessage', () => resolve()));
  }

  waitUserMessage() {
    return new Promise(resolve => this.on('AddedUserMessage', () => resolve()));
  }

  addUserMessage(message) {
    assert.ok(message.botToken, 'The message must be of type object and must contain `botToken` field.');
    const d = new Date();
    const millis = d.getTime();
    const add = {
      time: millis,
      botToken: message.botToken,
      message,
      updateId: this.updateId,
      messageId: this.messageId,
      isRead: false,
    };
    this.storage.userMessages.push(add);
    this.messageId++;
    this.updateId++;
    this.emit('AddedUserMessage');
  }

  messageFilter(message) {
    const d = new Date();
    const millis = d.getTime();
    return message.time > millis - this.config.storeTimeout;
  }

  cleanUp() {
    debugStorage('clearing storage');
    debugStorage(`current userMessages storage: ${this.storage.userMessages.length}`);
    this.storage.userMessages = this.storage.userMessages.filter(this.messageFilter, this);
    debugStorage(`filtered userMessages storage: ${this.storage.userMessages.length}`);
    debugStorage(`current botMessages storage: ${this.storage.botMessages.length}`);
    this.storage.botMessages = this.storage.botMessages.filter(this.messageFilter, this);
    debugStorage(`filtered botMessages storage: ${this.storage.botMessages.length}`);
  }

  cleanUpDaemon() {
    const self = this;
    if (this.started) {
      this.cleanUp();
      Promise.delay(this.config.storeTimeout)
        .then(() => self.cleanUpDaemon());
    }
  }

  /**
   * Obtains all updates (messages or any other content) sent or received by specified bot.
   * Doesn't mark updates as "read".
   * Very useful for testing `deleteMessage` Telegram API method usage.
   */
  getUpdatesHistory(token) {
    const getUpdateDate = ramda.prop('date');
    const isOwnUpdate = ramda.propEq('botToken', token);
    return ramda.compose(
      ramda.sortBy(getUpdateDate),
      ramda.filter(isOwnUpdate),
      ramda.concat
    )(
      this.storage.botMessages,
      this.storage.userMessages
    );
  }

  start() {
    const app = this.webServer;


    const self = this;
    return Promise.resolve()
      .then(() => { // set up middleware
        for (let i = 0; i < Routes.length; i++) {
          Routes[i](app, self);
        }
      })
      .then(() => {
        // there was no route to process request
        app.use((req, res, next) => {
          res.sendError(new Error('Route not found'));
        });
        // Catch express bodyParser error, like http://stackoverflow.com/questions/15819337/catch-express-bodyparser-error
        app.use((error, req, res, next) => {
          debug(`Error: ${error}`);
          res.sendError(new Error(`Something went wrong. ${error}`));
        });
      })
      .then(() => new Promise((resolve) => {
        self.server = http.createServer(app);
        self.server = shutdown(self.server);
        self.server.listen(self.config.port, self.config.host, () => {
          debug(`Telegram API server is up on port ${self.config.port} in ${app.settings.env} mode`);
          self.started = true;
          self.cleanUpDaemon();
          resolve();
        });
      }));
  }

  removeUserMessage(updateId) {
    this.storage.userMessages = this.storage.userMessages
      .filter(update => (update.updateId !== updateId));
  }

  removeBotMessage(updateId) {
    this.storage.botMessages = this.storage.botMessages
      .filter(update => update.updateId !== updateId);
  }

  /**
   * Deletes specified message from the storage: sent by bots or by clients.
   * @returns {boolean} - `true` if the message was deleted successfully.
   */
  deleteMessage(chatId, messageId) {
    const isMessageToDelete = update => (
      update.message.chat.id === chatId && update.messageId === messageId
    );
    const userUpdate = this.storage.userMessages.find(isMessageToDelete);

    if (userUpdate) {
      this.removeUserMessage(userUpdate.updateId);
      return true;
    }

    const botUpdate = this.storage.botMessages.find(isMessageToDelete);

    if (botUpdate) {
      this.removeBotMessage(botUpdate.updateId);
      return true;
    }

    return false;
  }

  close() {
    this.storage = {
      userMessages: [],
      botMessages: [],
    };
  }

  stop() {
    const self = this;
    return new Promise((resolve) => {
      if (self.server === undefined) {
        debug('Cant stop server - it is not running!');
        resolve();
        return;
      }
      debug('Stopping server...');
      self.server.shutdown(() => {
        self.close();
        debug('Server shutdown ok');
        self.started = false;
        resolve();
      });
    }).then(()=>Promise.delay(50));
  }
}

module.exports = TelegramServer;
