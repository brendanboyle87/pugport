export type CursorChat = {
  composerId: string;
  name: string;
  updatedAt?: string;
  conversationId?: string;
};

export type CursorChatList = { installed: boolean; chats: CursorChat[] };
