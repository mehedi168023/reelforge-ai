// One door for voice work, so the rest of the app doesn't care which provider is set up.
import { settings } from './store';
import type { Word } from './eleven';
import * as eleven from './eleven';
import * as cartesia from './cartesia';

const onCartesia = () => settings.voiceProvider === 'cartesia';

/** Speak the text with the active provider's voice, into an mp3. */
export function synthVoice(text: string, language?: string): Promise<Blob> {
  return onCartesia()
    ? cartesia.speak(settings.cartesiaKey, settings.cartesiaVoiceId, settings.cartesiaModel, text, language)
    : eleven.speak(settings.elevenKey, settings.voiceId, settings.voiceModel, text, language);
}

/** Word timings from a voice or video file, through the active provider. */
export function transcribeAudio(file: Blob, fileName: string, language?: string): Promise<Word[]> {
  return onCartesia()
    ? cartesia.transcribe(settings.cartesiaKey, file, fileName, language)
    : eleven.transcribe(settings.elevenKey, file, fileName, language);
}
