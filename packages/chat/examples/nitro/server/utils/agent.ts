export async function answerWithContext(prompt: string, _apiKey: string, _model: string) {
  return {
    fullStream: (async function* () {
      yield `Echo: ${prompt}`
    })(),
  }
}
