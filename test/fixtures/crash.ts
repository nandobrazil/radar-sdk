import { RadarClient } from '../../src/client.js';

const mode = process.argv[2];

const client = new RadarClient();
client.init(mode === 'disabled-reject' ? { captureUnhandled: true } : { key: 'rk_test', endpoint: process.env.RADAR_ENDPOINT, captureUnhandled: true });

if (mode === 'throw') {
  setTimeout(() => {
    throw new Error('crash now');
  }, 10);
}

if (mode === 'reject') {
  setTimeout(() => {
    void Promise.reject(new Error('rejected now'));
  }, 10);
}

if (mode === 'reject-with-listener') {
  process.on('unhandledRejection', () => undefined);
  setTimeout(() => {
    void Promise.reject(new Error('handled elsewhere'));
    setTimeout(() => {
      void client.flush().then(() => process.exit(0));
    }, 50);
  }, 10);
}

if (mode === 'reject-warn' || mode === 'disabled-reject') {
  setTimeout(() => {
    void Promise.reject(new Error('tolerated rejection'));
    setTimeout(() => {
      void client.flush().then(() => {
        process.stdout.write('still alive');
        process.exitCode = 0;
      });
    }, 50);
  }, 10);
}

if (mode === 'reject-string') {
  setTimeout(() => {
    void Promise.reject('plain string reason');
  }, 10);
}
