-- Forum topics: a supergroup with topics enabled needs message_thread_id on every
-- send, otherwise Telegram drops the message into the "General" topic. The id is
-- only observable from a message posted inside the topic, never from my_chat_member,
-- so it is captured when /subscribe runs there.
ALTER TABLE chats ADD COLUMN thread_id INTEGER;
