const Botkit = require('botkit');
const request = require('superagent');
const Wit = require('node-wit').Wit;
const Log = require('node-wit').log;
const config = require('./config');

const port = process.env.PORT || 3000;

const controller = Botkit.slackbot({
  debug: false,
  retry: Infinity,
});

const beepboop = require('beepboop-botkit').start(controller, { debug: true });

beepboop.on('botkit.rtm.started', (bot, resource, meta) => {
  const slackUserId = resource.SlackUserId;

  if(meta.isNew && slackUserId) {
    bot.startPrivateConversation({ user: slackUserId}, (err, convo) => {
      if(err) {
        console.log(err);
      } else {
        convo.say('I am a bot that has just joined your team');
        convo.say('You must now /invite me to a channel so that I can be of use!');
      }
    });
  }
});

controller.setupWebserver(port, (err, expressWebserver) => {
  controller.createWebhookEndpoints(expressWebserver, [process.env.SLACK_VERIFY_TOKEN]);
});

controller.on('slash_command', (bot, message) => {
  console.log(message);

  let number;

  if (message.text !== '') {
    number = message.text;
  } else {
    number = Math.floor(Math.random() * 100);
  }

  bot.replyPrivate(message, 'Command received :hourglass:');

  request
    .get(`http://numbersapi.com/${number}`)
    .end((err, res) => {
      if(err) {
        bot.replyPrivateDelayed(message, 'Got an error, can you try again with a valid number?');
      } else {
        bot.replyPrivateDelayed(message, res.text);
      }
    });
});

const sendTrivia = () => {
  const date = new Date();
  const today = `${date.getMonth() + 1}/${date.getDate()}`;

  request
    .get(`http://numbersapi.com/${today}/date`)
    .end((err, res) => {
      if(err) {
        console.error('Got an error from the Numbers API: ', err.stack || err);
      } else {
        Object.keys(beepboop.workers).forEach((id) => {
          const bot = beepboop.workers[id].worker;

          if(bot.config.SlackIncomingWebhookURL) {
            bot.configureIncomingWebhook( {url: bot.config.SlackIncomingWebhookURL});
            bot.sendWebhook({
              text: res.text,
            },
            (webhookErr, webhookRes) => {
              if(webhookErr) {
                console.error('Got an error when sending the webhook: ', webhookErr.stack || webhookErr);
              } else {
                console.log(webhookRes);
              }
            });
          }
        });
      }
    });
};

const interval = config.SEND_TRIVIA_FREQ_MS;
setInterval(sendTrivia, interval);

controller.on('channel_joined', (bot, { channel: { id, name } }) => {
  bot.say({
    text: `Thank you for inviting me to channel ${name}`,
    channel: id,
  });
});

const CALLBACK_ID = 'triviaCommand';
controller.hears(['[0-9]+'], ['ambient'], (bot, message) => {
  bot.api.reactions.add({
    timestamp: message.ts,
    channel: message.channel,
    name: 'thinking_face',
  }, (err) => {
    if(err) {
      console.log(err);
    }
  });

  const [number] = message.match;
  
  bot.reply(message, {
    text: `What kind of trivia about ${number} do you want?`,
    attachments: [
      {
        text: 'Choose the type of trivia',
        callback_id: CALLBACK_ID,
        attachment_type: 'default',
        color: '#3AA3E3',
        actions: [
          {
            name: 'general',
            text: 'General',
            value: number,
            type: 'button',
          },
          {
            name: 'math',
            text: 'Math',
            value: number,
            type: 'button',
          },
          {
            name: 'date',
            text: 'Date',
            value: number,
            type: 'button',
          },
        ],
      },
    ],
  });
});

controller.on('interactive_message_callback', (bot, message) => {
  console.log(message);
  bot.replyAcknowledge();

  if(message.callback_id === CALLBACK_ID) {
    const response = message.actions[0];
    const type = response.name !== 'general'
                   ? response.name
                   : '';
    const number = response.value;

    request
      .get(`http://numbersapi.com/${number}/${type}`)
      .end((err, res) => {
        if(err) {
          bot.replyInteractive(message, 'Got an error, can you try again with a valid number?');
        } else {
          bot.replyInteractive(message, res.text);
        }
      });
  }
});

const sessions = {};

const maybeCreateSession = (userId, bot, message) => {
  if(!sessions[userId]) {
    sessions[userId] = {
      userId,
      context: {},
      bot,
      message
    };
  }

  return userId;
};

const firstEntityValue = (entities, entity) => {
  const match = entities && entities[entity];
  const isFullArray = Array.isArray(match) && match.length > 0;
  const val = isFullArray ? match[0].value : null;

  if (!val) {
    return null;
  }

  return typeof val === 'object' ? val.value : val;
};

const actions = {
  send(req, res) {
    const { bot, message } = sessions[req.sessionId];
    const text = res.text;

    return new Promise(resolve => {
      bot.reply(message, text);
      return resolve();
    });
  },
  getTrivia({ context, entities}) {
    return new Promise(resolve => {
      const intent = firstEntityValue(entities, 'intent');
      const random = firstEntityValue(entities, 'random');
      const rawType = firstEntityValue(entities, 'type');

      const type = (rawType
          ? rawType !== 'general' ? rawType : ''
          : context.type)
        || '';
      const number = random ? 'random' : firstEntityValue(entities, 'number');
      const newContext = Object.assign({}, context);

      console.log(entities);

      if(intent && (intent === 'trivia') || number) {
        if(number) {
          request
            .get(`http://numbersapi.com/${number}/${type}`)
            .end((err, { text }) => {
              if(err) {
                newContext.response = 'Sorry, I couldn\'t process your request';
              } else {
                newContext.response = `*This is what I found* :point_down:\n_${text}_`;
              }
              newContext.done = true;
              delete newContext.missingNumber;

              return resolve(newContext);
            }
          );
        } else {
          newContext.type = type;
          newContext.missingNumber = true;

          return resolve(newContext);
        }
      } else {
        newContext.response = 'Sorry, I didn\'t understand what you want. I\'m still just a bot, ' +
          'can you try again?';
        newContext.done = true;

        return resolve(newContext);
      }
    });
  }
};

const wit = new Wit({
  accessToken: process.env.wit_token,
  actions,
  logger: new Log.Logger(Log.INFO)
});

controller.hears(['(.*)'], ['direct_mention', 'mention'], (bot, message) => {
  bot.startTyping(message);
  const [ text ] = message.match;

  const sessionId = maybeCreateSession(message.user, bot, message);

  wit.runActions(
    sessionId,
    text,
    sessions[sessionId].context
  ).then(context => {
    if(context.done) {
      delete sessions[sessionId];
    } else {
      sessions[sessionId].context = context;
    }
  }).catch((err) => {
    console.error('Got an error from Wit: ', err.stack || err);
  });
});
