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
      last_read_admin_msg BIGINT NOT NULL DEFAULT 0
    );
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
    const made = await supabase.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: '10MB',
      allowedMimeTypes: ['application/pdf','image/png','image/jpeg','image/gif','image/webp','text/plain','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/zip','application/x-zip-compressed']
    });
    if (made.error && !String(made.error.message).toLowerCase().includes('already exists')) throw made.error;
  } else if (error) {
    throw error;
  }
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1', [email]);
  return rows[0];
}
async function getUserById(id) {
  const { rows } = await pool.query('SELECT id,name,email,status,created_at,approved_at,last_read_user_msg,last_read_admin_msg FROM users WHERE id=$1', [id]);
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
module.exports={pool,init,getUserByEmail,getUserById,createUser,listUsers,setStatus,addMessage,getMessages,getFile,markAdminRead,markUserRead,uploadFile,downloadFile,removeFiles,close:()=>pool.end()};
