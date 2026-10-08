import { RadarClient } from '../../src/client.js';

const client = new RadarClient();
client.init({ key: 'rk_test', endpoint: process.env.RADAR_ENDPOINT, captureUnhandled: true });

const mode = process.argv[2];

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
