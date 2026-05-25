const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const env     = {};
fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
  const eq = line.indexOf('=');
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
});

module.exports = {
  apps: [{
    name:               'notifier',
    script:             './notifier.js',
    cwd:                __dirname,
    instances:          1,
    autorestart:        true,
    watch:              false,
    max_memory_restart: '100M',
    env: {
      NODE_ENV:           'production',
      TZ:                 'America/Argentina/Buenos_Aires',
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID:   env.TELEGRAM_CHAT_ID,
      DB_PATH:            env.DB_PATH || path.join(__dirname, 'queue.db'),
      POLL_INTERVAL:      env.POLL_INTERVAL    || '2000',
      MAX_RETRIES:        env.MAX_RETRIES      || '3',
      BATCH_SIZE:         env.BATCH_SIZE       || '10',
      TTS_PORT:     env.TTS_PORT     || '9876',
      TTS_VOICE:    env.TTS_VOICE    || 'es-AR-TomasNeural',
      DND_START:    env.DND_START    || '23',
      DND_END:      env.DND_END      || '8',
      DND_CHANNELS:         env.DND_CHANNELS         || 'google_home',
      QUEUE_RETENTION_DAYS: env.QUEUE_RETENTION_DAYS || '30',
      GOOGLE_HOME_DEVICE:   env.GOOGLE_HOME_DEVICE   || ''
    },
    error_file:      './logs/error.log',
    out_file:        './logs/output.log',
    log_file:        './logs/combined.log',
    time:            true,
    merge_logs:      true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
