/** Input problems the calling agent can fix; messages are safe to return. */
export class IdeaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdeaError';
  }
}
