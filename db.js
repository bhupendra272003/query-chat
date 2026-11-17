'use strict';
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'query-chat-files';

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at BIGINT NOT NULL,
      approved_at BIGINT,
      last_read_user_msg BIGINT NOT NULL DEFAULT 0,
      last_read_admin_msg BIGINT NOT NULL DEFAULT 0,
      password_reset_required BOOLEAN NOT NULL DEFAULT FALSE
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS chat_groups (
      id BIGSERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, description VARCHAR(240) NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at BIGINT NOT NULL, PRIMARY KEY(group_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      sender_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      sender_role VARCHAR(5) NOT NULL CHECK(sender_role IN ('admin','user')),
      body TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id,id);
    CREATE TABLE IF NOT EXISTS direct_messages (id BIGSERIAL PRIMARY KEY, sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_direct_pair ON direct_messages(sender_id,recipient_id,id);
    CREATE TABLE IF NOT EXISTS shared_files (
      id BIGSERIAL PRIMARY KEY, conversation_type VARCHAR(8) NOT NULL CHECK(conversation_type IN ('direct','group')),
      message_id BIGINT NOT NULL, owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size BIGINT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shared_files_message ON shared_files(conversation_type,message_id);
    CREATE TABLE IF NOT EXISTS user_preferences (user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, theme VARCHAR(12) NOT NULL DEFAULT 'dark', status_text VARCHAR(80) NOT NULL DEFAULT '', updated_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS activity_logs (id BIGSERIAL PRIMARY KEY, actor_role VARCHAR(8) NOT NULL, actor_user_id BIGINT, action VARCHAR(80) NOT NULL, target_type VARCHAR(24) NOT NULL DEFAULT '', target_id BIGINT, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender VARCHAR(5) NOT NULL CHECK (sender IN ('user','admin')),
      body TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id BIGSERIAL PRIMARY KEY,
      message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      size BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id,id);
    CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id);
  `);
  const { data, error } = await supabase.storage.getBucket(BUCKET);
  if (error && (error.statusCode === '404' || error.status === 404)) {
    const made = await supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: '50MB', allowedMimeTypes: null });
    if (made.error && !String(made.error.message).toLowerCase().includes('already exists')) throw made.error;
  } else if (error) {
    throw error;
  } else {
    const updated = await supabase.storage.updateBucket(BUCKET, { public: false, fileSizeLimit: '50MB', allowedMimeTypes: null });
    if (updated.error) throw updated.error;
  }
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1', [email]);
  return rows[0];
}
async function getUserById(id) {
  const { rows } = await pool.query('SELECT id,name,email,status,created_at,approved_at,last_read_user_msg,last_read_admin_msg,password_reset_required FROM users WHERE id=$1', [id]);
  return rows[0];
}
async function createUser(name,email,hash) {
  const { rows } = await pool.query('INSERT INTO users(name,email,password_hash,status,created_at) VALUES($1,$2,$3,\'pending\',$4) RETURNING id', [name,email,hash,Date.now()]);
  return Number(rows[0].id);
}
async function listUsers() {
  const { rows } = await pool.query(`SELECT u.id,u.name,u.email,u.status,u.created_at,u.last_read_admin_msg,
    (SELECT body FROM messages WHERE user_id=u.id ORDER BY id DESC LIMIT 1) AS last_body,
    (SELECT sender FROM messages WHERE user_id=u.id ORDER BY id DESC LIMIT 1) AS last_sender,
    COALESCE((SELECT created_at FROM messages WHERE user_id=u.id ORDER BY id DESC LIMIT 1),u.created_at) AS last_activity,
    (SELECT COUNT(*) FROM messages m WHERE m.user_id=u.id AND m.sender='user' AND m.id>u.last_read_admin_msg) AS unread
    FROM users u ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, last_activity DESC`);
  return rows.map(r => ({...r, id:Number(r.id), unread:Number(r.unread)}));
}
async function setUserPassword(id,hash) { await pool.query('UPDATE users SET password_hash=$1,password_reset_required=TRUE WHERE id=$2',[hash,id]); }
async function changeUserPassword(id,hash) { await pool.query('UPDATE users SET password_hash=$1,password_reset_required=FALSE WHERE id=$2',[hash,id]); }
async function listGroups() { const {rows}=await pool.query(`SELECT g.id,g.name,g.description,g.created_at,COUNT(gm.user_id)::int AS member_count FROM chat_groups g LEFT JOIN group_members gm ON gm.group_id=g.id GROUP BY g.id ORDER BY g.created_at DESC`); return rows.map(x=>({...x,id:Number(x.id),member_count:Number(x.member_count)})); }
async function createGroup(name,description,userIds) { const c=await pool.connect(); try { await c.query('BEGIN'); const r=await c.query('INSERT INTO chat_groups(name,description,created_at) VALUES($1,$2,$3) RETURNING id',[name,description,Date.now()]); for(const id of userIds) await c.query('INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[r.rows[0].id,id,Date.now()]); await c.query('COMMIT'); return Number(r.rows[0].id); } catch(e){await c.query('ROLLBACK');throw e} finally{c.release()} }
async function getUserGroups(userId) { const {rows}=await pool.query(`SELECT g.id,g.name,g.description,g.created_at FROM chat_groups g JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=$1 ORDER BY g.created_at DESC`,[userId]); return rows.map(x=>({...x,id:Number(x.id)})); }
async function getGroupMembers(groupId) { const {rows}=await pool.query(`SELECT u.id,u.name,u.email FROM users u JOIN group_members gm ON gm.user_id=u.id WHERE gm.group_id=$1 ORDER BY u.name`,[groupId]); return rows.map(x=>({...x,id:Number(x.id)})); }
async function getGroupMessages(groupId) { const {rows}=await pool.query(`SELECT m.id,m.group_id,m.sender_role,m.sender_user_id,m.body,m.created_at,u.name AS sender_name FROM group_messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.group_id=$1 ORDER BY m.id`,[groupId]); const ids=rows.map(x=>Number(x.id)); const files=await getSharedFiles('group',ids); return rows.map(x=>({...x,id:Number(x.id),group_id:Number(x.group_id),files:files[x.id]||[]})); }
async function addGroupMessage(groupId,userId,role,body) { const {rows}=await pool.query('INSERT INTO group_messages(group_id,sender_user_id,sender_role,body,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id,group_id,sender_user_id,sender_role,body,created_at',[groupId,userId,role,body,Date.now()]); const x=rows[0]; return {...x,id:Number(x.id),group_id:Number(x.group_id),sender_user_id:x.sender_user_id?Number(x.sender_user_id):null}; }
async function isGroupMember(groupId,userId) { const {rowCount}=await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[groupId,userId]); return rowCount>0; }
async function addGroupMembers(groupId,userIds) { for(const id of userIds) await pool.query('INSERT INTO group_members(group_id,user_id,joined_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[groupId,id,Date.now()]); }
async function deleteGroup(groupId) { await pool.query('DELETE FROM chat_groups WHERE id=$1',[groupId]); }
async function deleteUser(id) { const {rows}=await pool.query('SELECT stored_name FROM files WHERE user_id=$1',[id]); await pool.query('DELETE FROM users WHERE id=$1',[id]); return rows.map(x=>x.stored_name); }
async function setStatus(id,status) {
  await pool.query('UPDATE users SET status=$1, approved_at=$2 WHERE id=$3', [status,status==='approved'?Date.now():null,id]);
}
async function addMessage(userId,sender,body,uploads) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now=Date.now();
    const ins=await client.query('INSERT INTO messages(user_id,sender,body,created_at) VALUES($1,$2,$3,$4) RETURNING id,user_id,sender,body,created_at', [userId,sender,body,now]);
    const msg=ins.rows[0];
    for (const f of uploads) {
      await client.query('INSERT INTO files(message_id,user_id,original_name,stored_name,mime,size,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [msg.id,userId,f.original_name,f.stored_name,f.mime,f.size,now]);
    }
    await client.query('COMMIT');
    msg.id=Number(msg.id); msg.user_id=Number(msg.user_id);
    msg.files=uploads.map((f,i)=>({id:null,original_name:f.original_name,mime:f.mime,size:f.size,stored_name:f.stored_name}));
    const { rows }=await pool.query('SELECT id,original_name,mime,size FROM files WHERE message_id=$1 ORDER BY id',[msg.id]);
    msg.files=rows.map(f=>({...f,id:Number(f.id),size:Number(f.size)}));
    return msg;
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function getMessages(userId) {
  const { rows }=await pool.query(`SELECT m.id,m.user_id,m.sender,m.body,m.created_at,
    COALESCE(json_agg(json_build_object('id',f.id,'original_name',f.original_name,'mime',f.mime,'size',f.size)) FILTER (WHERE f.id IS NOT NULL),'[]') AS files
    FROM messages m LEFT JOIN files f ON f.message_id=m.id WHERE m.user_id=$1 GROUP BY m.id ORDER BY m.id`,[userId]);
  return rows.map(m=>({...m,id:Number(m.id),user_id:Number(m.user_id),files:m.files.map(f=>({...f,id:Number(f.id),size:Number(f.size)}))}));
}

async function listContacts(userId) { const {rows}=await pool.query("SELECT id,name,email FROM users WHERE status='approved' AND id<>$1 ORDER BY name",[userId]);return rows.map(x=>({...x,id:Number(x.id)})); }
async function getDirectMessages(userId,otherId) { const {rows}=await pool.query("SELECT id,sender_id,recipient_id,body,created_at FROM direct_messages WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1) ORDER BY id",[userId,otherId]); const ids=rows.map(x=>Number(x.id)); const files=await getSharedFiles('direct',ids); return rows.map(x=>({...x,id:Number(x.id),sender_id:Number(x.sender_id),recipient_id:Number(x.recipient_id),files:files[x.id]||[]})); }
async function addDirectMessage(senderId,recipientId,body) { const {rows}=await pool.query("INSERT INTO direct_messages(sender_id,recipient_id,body,created_at) VALUES($1,$2,$3,$4) RETURNING id,sender_id,recipient_id,body,created_at",[senderId,recipientId,body,Date.now()]);const x=rows[0];return {...x,id:Number(x.id),sender_id:Number(x.sender_id),recipient_id:Number(x.recipient_id)}; }

async function addSharedFiles(type,messageId,ownerId,files) { for(const f of files) await pool.query("INSERT INTO shared_files(conversation_type,message_id,owner_user_id,original_name,stored_name,mime,size,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[type,messageId,ownerId,f.original_name,f.stored_name,f.mime,f.size,Date.now()]); }
async function getSharedFiles(type,ids) { if(!ids.length)return {}; const {rows}=await pool.query("SELECT id,message_id,original_name,mime,size FROM shared_files WHERE conversation_type=$1 AND message_id=ANY($2::bigint[]) ORDER BY id",[type,ids]); const out={}; for(const f of rows){(out[f.message_id] ||= []).push({...f,id:Number(f.id),message_id:Number(f.message_id),size:Number(f.size)})} return out; }
async function canAccessSharedFile(fileId,userId,role) { const {rows}=await pool.query("SELECT sf.conversation_type,sf.message_id,dm.sender_id,dm.recipient_id,gm.group_id FROM shared_files sf LEFT JOIN direct_messages dm ON sf.conversation_type='direct' AND dm.id=sf.message_id LEFT JOIN group_messages gm ON sf.conversation_type='group' AND gm.id=sf.message_id WHERE sf.id=$1",[fileId]); const x=rows[0]; if(!x)return false; if(role==='admin')return true; if(x.conversation_type==='direct')return Number(x.sender_id)===Number(userId)||Number(x.recipient_id)===Number(userId); return !!(await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',[x.group_id,userId])).rowCount; }
async function getSharedFile(id) { const {rows}=await pool.query("SELECT * FROM shared_files WHERE id=$1",[id]); return rows[0]; }
async function logActivity(role,userId,action,targetType='',targetId=null,details={}) { await pool.query("INSERT INTO activity_logs(actor_role,actor_user_id,action,target_type,target_id,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[role,userId,action,targetType,targetId,JSON.stringify(details),Date.now()]); }
async function listActivity(limit=100) { const {rows}=await pool.query("SELECT * FROM activity_logs ORDER BY id DESC LIMIT $1",[Math.min(200,Math.max(1,limit))]); return rows; }
async function getPreferences(userId) { const {rows}=await pool.query("SELECT theme,status_text FROM user_preferences WHERE user_id=$1",[userId]); return rows[0]||{theme:'dark',status_text:''}; }
async function savePreferences(userId,theme,statusText) { await pool.query("INSERT INTO user_preferences(user_id,theme,status_text,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET theme=EXCLUDED.theme,status_text=EXCLUDED.status_text,updated_at=EXCLUDED.updated_at",[userId,theme,statusText,Date.now()]); }
async function getFile(id,userId) {
  const { rows }=await pool.query('SELECT * FROM files WHERE id=$1 AND user_id=$2',[id,userId]);
  return rows[0];
}
async function markAdminRead(id) {
  await pool.query('UPDATE users SET last_read_admin_msg=COALESCE((SELECT MAX(id) FROM messages WHERE user_id=$1),0) WHERE id=$1',[id]);
}
async function markUserRead(id) {
  await pool.query("UPDATE users SET last_read_user_msg=COALESCE((SELECT MAX(id) FROM messages WHERE user_id=$1 AND sender='admin'),0) WHERE id=$1",[id]);
}
async function uploadFile(path,buffer,mime) {
  const { error }=await supabase.storage.from(BUCKET).upload(path,buffer,{contentType:mime||'application/octet-stream',upsert:false});
  if(error) throw error;
  return path;
}
async function downloadFile(path) {
  const { data,error }=await supabase.storage.from(BUCKET).download(path);
  if(error) throw error;
  return Buffer.from(await data.arrayBuffer());
}
async function removeFiles(paths) {
  if(paths.length) await supabase.storage.from(BUCKET).remove(paths);
}
module.exports={pool,init,addSharedFiles,getSharedFiles,getSharedFile,canAccessSharedFile,logActivity,listActivity,getPreferences,savePreferences,getUserByEmail,getUserById,createUser,listUsers,setStatus,setUserPassword,changeUserPassword,listGroups,createGroup,getUserGroups,getGroupMembers,getGroupMessages,addGroupMessage,isGroupMember,addGroupMembers,deleteGroup,deleteUser,addMessage,getMessages,listContacts,getDirectMessages,addDirectMessage,getFile,markAdminRead,markUserRead,uploadFile,downloadFile,removeFiles,close:()=>pool.end()};
