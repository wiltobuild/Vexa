CREATE TABLE IF NOT EXISTS users (id bigint PRIMARY KEY,email text UNIQUE NOT NULL,username text NOT NULL,password_hash text NOT NULL,avatar_url text,bio text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
-- Case-insensitive uniqueness: friend requests and DMs look users up by username, so two accounts
-- with the same (or differently-cased) handle would be ambiguous. Dev-only data, so this is safe
-- to add now; it would need a rename/cleanup migration first against real duplicate usernames.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(lower(username));
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY,user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS guilds (id bigint PRIMARY KEY,name text NOT NULL,owner_id bigint NOT NULL REFERENCES users(id),features jsonb NOT NULL DEFAULT '{"transcription":false}');
CREATE TABLE IF NOT EXISTS guild_members (guild_id bigint REFERENCES guilds(id) ON DELETE CASCADE,user_id bigint REFERENCES users(id) ON DELETE CASCADE,nickname text,joined_at timestamptz NOT NULL DEFAULT now(),timeout_until timestamptz,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS roles (id bigint PRIMARY KEY,guild_id bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,name text NOT NULL,permissions bigint NOT NULL DEFAULT 0,position integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS member_roles (guild_id bigint,user_id bigint,role_id bigint REFERENCES roles(id) ON DELETE CASCADE,PRIMARY KEY(guild_id,user_id,role_id),FOREIGN KEY(guild_id,user_id) REFERENCES guild_members(guild_id,user_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS channels (id bigint PRIMARY KEY,guild_id bigint REFERENCES guilds(id) ON DELETE CASCADE,name text NOT NULL,type text NOT NULL CHECK(type IN ('text','voice','category','dm','group_dm')),parent_id bigint REFERENCES channels(id) ON DELETE SET NULL,position integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS permission_overwrites (channel_id bigint REFERENCES channels(id) ON DELETE CASCADE,target_type text NOT NULL CHECK(target_type IN ('role','member')),target_id bigint NOT NULL,allow_bits bigint NOT NULL DEFAULT 0,deny_bits bigint NOT NULL DEFAULT 0,PRIMARY KEY(channel_id,target_type,target_id));
CREATE TABLE IF NOT EXISTS messages (id bigint PRIMARY KEY,channel_id bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,author_id bigint NOT NULL REFERENCES users(id),content text NOT NULL,nonce uuid NOT NULL,edited_at timestamptz,reply_to bigint REFERENCES messages(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(author_id,nonce));
CREATE INDEX IF NOT EXISTS messages_channel_cursor ON messages(channel_id,id DESC);
CREATE INDEX IF NOT EXISTS messages_search ON messages USING gin(to_tsvector('english',content));
CREATE TABLE IF NOT EXISTS relationships (user_id bigint REFERENCES users(id),target_id bigint REFERENCES users(id),kind text CHECK(kind IN ('friend','blocked','pending')),PRIMARY KEY(user_id,target_id));
CREATE TABLE IF NOT EXISTS dm_members (channel_id bigint REFERENCES channels(id) ON DELETE CASCADE,user_id bigint REFERENCES users(id),PRIMARY KEY(channel_id,user_id));
CREATE TABLE IF NOT EXISTS attachments (id bigint PRIMARY KEY,message_id bigint REFERENCES messages(id) ON DELETE CASCADE,object_key text NOT NULL,mime_type text NOT NULL,size_bytes bigint NOT NULL);
CREATE TABLE IF NOT EXISTS reactions (message_id bigint REFERENCES messages(id) ON DELETE CASCADE,user_id bigint REFERENCES users(id),emoji text,PRIMARY KEY(message_id,user_id,emoji));
CREATE TABLE IF NOT EXISTS mentions (message_id bigint REFERENCES messages(id) ON DELETE CASCADE,user_id bigint REFERENCES users(id),PRIMARY KEY(message_id,user_id));
CREATE TABLE IF NOT EXISTS read_states (user_id bigint REFERENCES users(id),channel_id bigint REFERENCES channels(id) ON DELETE CASCADE,last_read_message_id bigint,mention_count integer NOT NULL DEFAULT 0,PRIMARY KEY(user_id,channel_id));
CREATE TABLE IF NOT EXISTS invites (code text PRIMARY KEY,guild_id bigint REFERENCES guilds(id) ON DELETE CASCADE,created_by bigint REFERENCES users(id),expires_at timestamptz,max_uses integer,uses integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bans (guild_id bigint REFERENCES guilds(id),user_id bigint REFERENCES users(id),reason text,PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS audit_log (id bigint PRIMARY KEY,guild_id bigint REFERENCES guilds(id),actor_id bigint REFERENCES users(id),action text NOT NULL,target_id bigint,details jsonb,created_at timestamptz NOT NULL DEFAULT now());

-- Personal Recall notes are never shared with a guild or channel. Raw audio is not stored.
CREATE TABLE IF NOT EXISTS personal_transcripts (id bigint PRIMARY KEY,user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,text text NOT NULL,segments jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS personal_transcripts_user_cursor ON personal_transcripts(user_id,id DESC);
CREATE INDEX IF NOT EXISTS personal_transcripts_retention ON personal_transcripts(created_at);

-- Durable message delivery. Trigger and message write commit together, including retries.
CREATE TABLE IF NOT EXISTS message_outbox (id bigserial PRIMARY KEY,event_type text NOT NULL,channel_id bigint NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION enqueue_message_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE message_data jsonb; author_name text; author_avatar text;
BEGIN
 IF TG_OP='DELETE' THEN
  INSERT INTO message_outbox(event_type,channel_id,payload) VALUES('message.delete',OLD.channel_id,jsonb_build_object('id',OLD.id::text,'channel_id',OLD.channel_id::text));
  RETURN OLD;
 END IF;
 SELECT username,avatar_url INTO author_name,author_avatar FROM users WHERE id=NEW.author_id;
 message_data=to_jsonb(NEW)||jsonb_build_object('id',NEW.id::text,'channel_id',NEW.channel_id::text,'author_id',NEW.author_id::text,'reply_to',NEW.reply_to::text,'username',author_name,'avatar_url',author_avatar);
 INSERT INTO message_outbox(event_type,channel_id,payload) VALUES(CASE WHEN TG_OP='INSERT' THEN 'message.create' ELSE 'message.update' END,NEW.channel_id,message_data);
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER messages_enqueue AFTER INSERT OR UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION enqueue_message_event();
