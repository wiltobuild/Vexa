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
