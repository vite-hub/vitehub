// The Jev question builders and types live in @vite-hub/gateways, so AI gateways can ask them without the Agent package.
export { ask } from "@vite-hub/gateways"
export type {
  AskAnswer,
  AskAnswers,
  AskAnswerType,
  AskChanceAnswer,
  AskChanceCriteria,
  AskChanceQuestion,
  AskChoiceAnswer,
  AskChoiceCriteria,
  AskChoiceLabels,
  AskChoiceQuestion,
  AskEntry,
  AskIfQuestion,
  AskJson,
  AskQuestion,
  AskQuestions,
  AskScoreAnswer,
  AskScoreCriteria,
  AskScoreQuestion,
  AskSwitchQuestion,
} from "@vite-hub/gateways"
