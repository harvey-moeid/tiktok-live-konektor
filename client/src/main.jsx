import React,{useEffect,useMemo,useState}from'react';
import{createRoot}from'react-dom/client';
import{io}from'socket.io-client';
import'./styles.css';
import WebhookSettings from './WebhookSettings.jsx';

const filters=[
  ['all','Semua'],['chat','Komentar'],['like','Like'],['gift','Gift'],
  ['follow','Follow'],['share','Share'],['member','Masuk'],['viewer','Viewer'],['stream','Status']
];
const visibleTypes=new Set(filters.slice(1).map(x=>x[0]));
const labels={chat:'Komentar',like:'Like',gift:'Gift',follow:'Follow',share:'Share',member:'Masuk',viewer:'Viewer',stream:'LIVE'};
const icons={chat:'💬',like:'♥',gift:'🎁',follow:'＋',share:'↗',member:'👋',viewer:'◉',stream:'●'};

async function api(path,options={}){
  const r=await fetch(path,{credentials:'include',headers:{'content-type':'application/json'},...options});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.error||'HTTP '+r.status);
  return d;
}

function Login({done}){
  const[u,setU]=useState('admin'),[p,setP]=useState(''),[e,setE]=useState('');
  return <main className="auth"><form onSubmit={async x=>{
    x.preventDefault();setE('');
    try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:u,password:p})});done()}
    catch(err){setE(err.message)}
  }}>
    <div className="brand"><span className="brand-mark">TLK</span><div><h1>TikTok Live Konektor</h1><p>Realtime event bridge</p></div></div>
    <label>Username</label><input autoComplete="username"value={u}onChange={x=>setU(x.target.value)}placeholder="Username"/>
    <label>Password</label><input autoComplete="current-password"type="password"value={p}onChange={x=>setP(x.target.value)}placeholder="Password"/>
    {e&&<div className="error">{e}</div>}<button className="primary">Masuk</button>
  </form></main>
}

function compact(n){
  const x=Number(n)||0;
  return Intl.NumberFormat('id-ID',{notation:x>=1000?'compact':'standard',maximumFractionDigits:1}).format(x);
}
function actorOf(x){
  const d=x?.data||{};
  const nickname=String(d.nickname||'').trim();
  const username=String(d.username||'').trim();
  if(nickname)return {name:nickname,handle:username&&username!=='unknown'&&username!==nickname?'@'+username:''};
  if(username&&username!=='unknown')return {name:'@'+username,handle:''};
  return {name:'Penonton TikTok',handle:''};
}
function eventBody(x){
  const d=x?.data||{};
  switch(x.event){
    case'chat':return d.message||'Komentar';
    case'like':return `memberi ${compact(d.likeCount||1)} like`;
    case'gift':return `mengirim ${d.giftName||'gift'}${Number(d.repeatCount)>1?' ×'+compact(d.repeatCount):''}`;
    case'follow':return 'mulai mengikuti';
    case'share':return 'membagikan LIVE';
    case'member':return 'bergabung ke LIVE';
    case'viewer':return `${compact(d.viewerCount)} penonton sedang menonton`;
    case'stream':return d.state==='started'?'LIVE terhubung':'LIVE berakhir';
    default:return '';
  }
}
function EventCard({item,onDelete,historyBusy}){
  const actor=actorOf(item), body=eventBody(item), isSystem=['viewer','stream'].includes(item.event);
  return <article className={'event event-'+item.event}>
    <div className="event-icon" aria-hidden="true">{icons[item.event]||'•'}</div>
    <div className="event-main">
      <div className="event-top">
        <div className="event-identity">
          <strong>{isSystem?labels[item.event]:actor.name}</strong>
          {!isSystem&&actor.handle&&<span>{actor.handle}</span>}
        </div>
        <div className="event-meta">
          <time>{new Date(item.timestamp).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>
          <button type="button" className="event-delete" onClick={()=>onDelete(item)}
            disabled={!!historyBusy||!item.id} aria-label={'Hapus aktivitas '+(labels[item.event]||item.event)}
            title="Hapus aktivitas">{historyBusy===item.id?'Menghapus…':'🗑 Hapus'}</button>
        </div>
      </div>
      <div className={'event-copy '+(item.event==='chat'?'comment':'')}>{body}</div>
      {item.event!=='chat'&&<span className="event-label">{labels[item.event]||item.event}</span>}
    </div>
  </article>
}

function Stat({label,value,sub}){
  return <div className="stat"><span>{label}</span><strong>{compact(value)}</strong>{sub&&<small>{sub}</small>}</div>
}

function Dashboard({logout}){
  const[s,setS]=useState(),[c,setC]=useState(),[events,setEvents]=useState([]),[f,setF]=useState('all'),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const[tab,setTab]=useState('live'),[configError,setConfigError]=useState('');
  const[historyBusy,setHistoryBusy]=useState(''),[historyFeedback,setHistoryFeedback]=useState(null);
  useEffect(()=>{
    let mounted=true;
    api('/api/state').then(x=>mounted&&setS(x)).catch(logout);
    api('/api/config').then(x=>mounted&&setC(x)).catch(e=>mounted&&setConfigError(e.message));
    const socket=io({path:'/socket.io',withCredentials:true,reconnection:true,reconnectionAttempts:Infinity});
    socket.on('state',x=>setS(x));
    socket.on('status',x=>setS(x));
    socket.on('event',x=>setEvents(v=>v.concat(x).slice(-500)));
    socket.on('stats',stats=>setS(v=>v?{...v,stats}:v));
    socket.on('history',x=>setEvents(Array.isArray(x)?x:[]));
    socket.on('history:removed',x=>setEvents(v=>v.filter(item=>item.id!==x?.id)));
    socket.on('history:cleared',()=>setEvents([]));
    socket.on('connect_error',()=>setNotice('Koneksi realtime terputus. Menghubungkan kembali…'));
    socket.on('connect',()=>setNotice(''));
    return()=>{mounted=false;socket.close()};
  },[logout]);

  const list=useMemo(()=>events.filter(x=>visibleTypes.has(x.event)&&(f==='all'||x.event===f)).slice().reverse(),[events,f]);
  if(!s)return <main className="loading">Loading…</main>;

  async function removeActivity(item){
    if(historyBusy||!item?.id)return;
    if(!window.confirm('Hapus aktivitas ini dari riwayat? Statistik LIVE dan webhook yang sudah terkirim tidak berubah.'))return;
    setHistoryBusy(item.id);setHistoryFeedback(null);
    try{
      await api('/api/events/'+encodeURIComponent(item.id),{method:'DELETE'});
      setEvents(v=>v.filter(x=>x.id!==item.id));
      setHistoryFeedback({kind:'success',message:'Aktivitas berhasil dihapus.'});
    }catch(e){setHistoryFeedback({kind:'error',message:e.message})}
    finally{setHistoryBusy('')}
  }
  async function clearActivities(){
    if(historyBusy||!events.length)return;
    if(!window.confirm('Hapus SEMUA '+events.length+' aktivitas dari riwayat? Tindakan ini tidak dapat dibatalkan. Statistik LIVE dan webhook yang sudah terkirim tidak berubah.'))return;
    // Remember which rows existed before the request: never remove fresh LIVE events
    // that arrive after the server has cleared history but before HTTP resolves.
    const idsBefore=new Set(events.map(x=>x.id));
    setHistoryBusy('all');setHistoryFeedback(null);
    try{
      const result=await api('/api/events',{method:'DELETE'});
      setEvents(v=>v.filter(x=>!idsBefore.has(x.id)));
      setHistoryFeedback({kind:'success',message:result.removed+' aktivitas berhasil dihapus.'});
    }catch(e){setHistoryFeedback({kind:'error',message:e.message})}
    finally{setHistoryBusy('')}
  }

  async function start(){
    setBusy(true);setNotice('');
    try{const x=await api('/api/live/start',{method:'POST',body:JSON.stringify({username:c?.tiktokUsername,roomId:c?.tiktokRoomId})});setS(x)}
    catch(e){setNotice(e.message)}finally{setBusy(false)}
  }
  async function stop(){
    setBusy(true);setNotice('');
    try{const x=await api('/api/live/stop',{method:'POST'});setS(x)}
    catch(e){setNotice(e.message)}finally{setBusy(false)}
  }
  async function save(){
    setBusy(true);
    try{
      const x=await api('/api/config',{method:'PUT',body:JSON.stringify({tiktokUsername:c?.tiktokUsername||'',tiktokRoomId:c?.tiktokRoomId||''})});
      setC(x);setS(v=>({...v,username:x.tiktokUsername,roomId:x.tiktokRoomId||null}));setNotice('Konfigurasi tersimpan');
    }catch(e){setNotice(e.message)}finally{setBusy(false)}
  }

  async function saveWebhooks(hooks) {
    const result=await api('/api/webhooks',{method:'PUT',body:JSON.stringify({webhooks:hooks})});
    setC(prev=>prev?{...prev,webhooks:result.webhooks}:prev);
    return result.webhooks;
  }

  async function retryConfig(){
    setConfigError('');
    try{setC(await api('/api/config'))}
    catch(e){setConfigError(e.message)}
  }

  const connected=s.status==='Connected';
  const stats=s.stats||{};
  return <main className="app-shell">
    <header>
      <div className="brand compact-brand"><span className="brand-mark">TLK</span><div><strong>TikTok Live Konektor</strong><small>Realtime dashboard</small></div></div>
      <div className={'status '+(connected?'online':'offline')}><i></i><span>{s.status}</span><b>@{c?.tiktokUsername||s.username||'—'}</b></div>
      <button className="ghost" onClick={async()=>{try{await api('/api/auth/logout',{method:'POST'})}finally{logout()}}}>Logout</button>
    </header>

    <nav className="dashboard-tabs" role="tablist" aria-label="Menu dashboard">
      <button type="button" role="tab" aria-selected={tab==='live'}
        className={tab==='live'?'active':''} onClick={()=>setTab('live')}>● Aktivitas LIVE</button>
      <button type="button" role="tab" aria-selected={tab==='webhooks'}
        className={tab==='webhooks'?'active':''} onClick={()=>setTab('webhooks')}>↗ Integrasi Webhook <span>{c?.webhooks?.length||0}</span></button>
    </nav>
    <section className="dashboard" hidden={tab!=='live'}>
      <aside>
        <div className="panel connection">
          <div className="panel-title"><div><h3>Koneksi LIVE</h3><p>Hubungkan akun TikTok yang sedang LIVE.</p></div><span className={'live-pill '+(connected?'on':'')}>{connected?'LIVE':'OFFLINE'}</span></div>
          <label>TikTok Username</label>
          <div className="input-prefix"><span>@</span><input value={c?.tiktokUsername||''}onChange={e=>setC(v=>({...v,tiktokUsername:e.target.value.replace(/^@/,''),tiktokRoomId:v?.tiktokRoomId||''}))}placeholder="username"/></div>
          <label>Room ID <em>opsional</em></label>
          <input inputMode="numeric"value={c?.tiktokRoomId||''}onChange={e=>setC(v=>({...v,tiktokRoomId:e.target.value.replace(/\D/g,'')}))}placeholder="Kosongkan untuk otomatis"/>
          <small className="hint">Biarkan kosong bila resolver otomatis aktif.</small>
          <div className="buttons"><button className="secondary" onClick={save}disabled={busy}>Simpan</button>{s.running?<button className="danger" onClick={stop}disabled={busy}>Stop LIVE</button>:<button className="primary" onClick={start}disabled={busy}>{busy?'Menghubungkan…':'Start LIVE'}</button>}</div>
          {notice&&<div className="notice">{notice}</div>}{s.error&&<div className="error-detail">{s.error}</div>}
        </div>

        <div className="stats-grid">
          <Stat label="Komentar" value={stats.chat}/>
          <Stat label="Like" value={stats.likes}/>
          <Stat label="Gift" value={stats.gifts}/>
          <Stat label="Coins" value={stats.giftCoins}/>
          <Stat label="Viewer" value={stats.viewerCount} sub={'Peak '+compact(stats.peakViewers)}/>
          <Stat label="Follow" value={stats.follows}/>
        </div>
      </aside>

      <section className="panel feed">
        <div className="feed-head">
          <div><h2>Aktivitas LIVE</h2><p>Event terbaru tampil paling atas.</p></div>
          <div className="feed-actions"><span>{list.length} event</span><button type="button" className="danger clear-history"
            onClick={clearActivities} disabled={!!historyBusy||!events.length}>{historyBusy==='all'?'Menghapus…':'🗑 Hapus Semua'}</button></div>
        </div>
        <nav>{filters.map(([key,label])=><button className={f===key?'active':''}onClick={()=>setF(key)}key={key}>{label}</button>)}</nav>
        {historyFeedback&&<div role="status" className={'history-feedback '+historyFeedback.kind}>{historyFeedback.message}</div>}
        <div className="event-list">{list.length?list.map(x=><EventCard item={x} key={x.id||x.timestamp} onDelete={removeActivity} historyBusy={historyBusy}/>):<div className="empty"><div>◌</div><strong>Belum ada aktivitas</strong><span>Komentar, like, gift, dan event LIVE akan muncul di sini.</span></div>}</div>
      </section>
    </section>
    <div className="webhook-shell" hidden={tab!=='webhooks'}>
      {c?<WebhookSettings initialHooks={c.webhooks} onSave={saveWebhooks}/>:<section className="webhook-load-error panel">
        <h2>Pengaturan webhook belum tersedia</h2>
        <p>{configError||'Memuat konfigurasi admin…'}</p>
        <button type="button" className="secondary" onClick={retryConfig}>Muat ulang</button>
      </section>}
    </div>
  </main>
}

function App(){
  const[a,setA]=useState(null);
  useEffect(()=>{api('/api/auth/me').then(()=>setA(1)).catch(()=>setA(0))},[]);
  return a===null?<main className="loading">Starting…</main>:a?<Dashboard logout={()=>setA(0)}/>:<Login done={()=>setA(1)}/>;
}
createRoot(document.getElementById('root')).render(<App/>);
