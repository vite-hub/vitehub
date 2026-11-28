export type MessageAlign = "start" | "end";

export interface MessageProps {
  /** The side the message speaks from. A reply from the viewer uses `end`. */
  align?: MessageAlign;
}

export interface MessageSlots {
  /** The parts of the message: `MessageAvatar` and `MessageContent`, with `MessageHeader` and `MessageFooter` in it. */
  default?: () => unknown;
}
