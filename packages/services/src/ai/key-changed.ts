/**
 * Thrown by the worker's guarded client before a request when the installation's AI key was
 * removed or replaced after the run started. No request was sent: the jobs treat it as a stop
 * (like a broken key) and never count it as an attempt.
 */
export class AiKeyChangedError extends Error {
  override name = 'AiKeyChangedError';
  constructor() {
    super('The AI key changed during the run');
  }
}
