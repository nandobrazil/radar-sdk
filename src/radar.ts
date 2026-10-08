import { RadarClient } from './client.js';
import { globalState } from './context.js';

const state = globalState();

export const radar: RadarClient = (state.client as RadarClient | undefined) ?? (state.client = new RadarClient());
