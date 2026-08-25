export enum AppState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  PROCESSING_STT = 'PROCESSING_STT',
  PLAYING_TTS = 'PLAYING_TTS',
  ERROR = 'ERROR',
}

export type AppAction =
  | { type: 'START_LISTENING' }
  | { type: 'STOP_LISTENING' }
  | { type: 'TTS_STARTED' }
  | { type: 'TTS_FINISHED' }
  | { type: 'ERROR'; error: string }
  | { type: 'DISMISS_ERROR' };

export interface AppStateContext {
  state: AppState;
  error?: string;
}

export function appReducer(state: AppStateContext, action: AppAction): AppStateContext {
  switch (action.type) {
    case 'START_LISTENING':
      return { ...state, state: AppState.LISTENING };
    case 'STOP_LISTENING':
      if (state.state === AppState.LISTENING) {
        return { ...state, state: AppState.PROCESSING_STT };
      }
      return state;
    case 'TTS_STARTED':
      return { ...state, state: AppState.PLAYING_TTS };
    case 'TTS_FINISHED':
      return { ...state, state: AppState.IDLE };
    case 'ERROR':
      return { ...state, state: AppState.ERROR, error: action.error };
    case 'DISMISS_ERROR':
      return { ...state, state: AppState.IDLE, error: undefined };
    default:
      return state;
  }
}
