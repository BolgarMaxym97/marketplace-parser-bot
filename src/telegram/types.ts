export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: { id: number };
  text?: string;
  /** Forum topic id. Also set for plain thread replies, hence is_topic_message. */
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: { id: number };
  new_chat_member: { status: string };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  my_chat_member?: TgChatMemberUpdated;
}

export interface TgInputMediaPhoto {
  type: 'photo';
  media: string;
  caption?: string;
  parse_mode?: 'HTML';
}
