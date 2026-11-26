/* Preventivo AGDP: web instalable del checklist pre-campaña.
 * Técnico: carga el checklist con o sin señal; la cola lo envía a Apps Script cuando hay conexión.
 * Soporte: lista y valida. El rol lo define el servidor al ingresar. */
'use strict';

const CFG = window.PREVENTIVO_CONFIG;
const TIPOS = {PREVENTIVO:'Preventivo', INSTALACION:'Instalación nueva'};
// tipo: el ítem aparece solo en ese tipo de trabajo; sin tipo, en los dos. El número se calcula al mostrar.
const ITEMS = [
  {k:'icaja', tipo:'INSTALACION', t:'Instalación de la caja', crit:'Caja Corvus fijada, con los conectores hacia abajo y protegida del agua y de golpes.', fotos:[['icaja','Foto de la caja instalada']]},
  {k:'itab', tipo:'INSTALACION', t:'Instalación de la tablet', crit:'Holder firme en la cabina, tablet a la vista del operario y cargador conectado.', fotos:[['itab','Foto de la tablet instalada en la cabina']]},
  {k:'isens', tipo:'INSTALACION', t:'Instalación del sensor', crit:'Sensor fijado según el mecanismo de descarga y con su cable sujeto.', fotos:[['isens','Foto del sensor instalado']]},
  {k:'icabl', tipo:'INSTALACION', t:'Cableados', crit:'Alimentación, cable de celdas y cable del sensor sujetos, sin tramos sueltos ni roces.', fotos:[['icabl','Foto del recorrido del cableado']]},
  {k:'conec', t:'Conectores de la caja', crit:'Conectores de energía y de celdas en buen estado. Video con la tablet al lado de la caja Corvus en la tolva, las dos a la vista: al mover el cable azul de celdas, los kg no se mueven. Eso prueba la conexión del CPC del cable y la ficha de la caja.', fotos:[['conec','Foto de la caja Corvus']], video:'vconec', videoTxt:'Video: tablet y caja a la vista mientras se mueve el cable azul de celdas',
    antes:{campo:'conecMovia', pregunta:'¿Los kg se movían al mover el cable azul?', video:'vconeca', txt:'Video ANTES de arreglar: los kg se mueven al mover el cable', txtDespues:'Video DESPUÉS de arreglar: los kg ya no se mueven'}},
  {k:'deriv', t:'Caja derivadora de celdas', crit:'Aislada del agua, sin conectores flojos adentro. Con golpes secos, el peso no cambia. Si el sello o la junta están dañados, se sella.', fotos:[['deriv1','Foto del interior'],['deriv2','Foto de la caja cerrada o sellada']], sellado:true},
  {k:'bal', t:'Balanza estable y cero', crit:'Etiqueta Estable encendida, sin alerta CELDA DESCONECTADA, cero correcto. El peso reacciona a una carga y vuelve a Estable.', fotos:[['cab','Foto de la cabecera de pesaje']]},
  {k:'fant', t:'Sin peso fantasma del tubo', crit:'Con la tolva parada, abrir y cerrar el tubo: el neto casi no cambia. Aceptable: menos de 40 kg. Ideal: 0 a 20 kg.', fotos:[], video:'vfant', kg:true},
  {k:'sens', t:'Sensor inductivo', crit:'Posición y distancia correctas. La luz del sensor se enciende al acercarle metal.', fotos:[['sensled','Foto del sensor con la luz encendida']]},
  {k:'desc', t:'Descarga automática de prueba', crit:'Al mover el tubo o el volquete, aparece la etiqueta Automática y la descarga cierra sola. Destino PREVENTIVO.', fotos:[['disp','Foto del DISPLAY con la etiqueta Automática']], prueba:true},
  {k:'carga', t:'Carga de la tablet', crit:'Con el cargador del equipo enchufado, la tablet carga. Si no carga, se cambia el cargador y se marca en Repuestos.', fotos:[['carga','Foto de la tablet cargando']]},
];
const itemsDe = tipo => ITEMS.filter(it => !it.tipo || it.tipo === tipo);
const REPUESTOS = ['Cargador','Sensor','Cable de alimentación','Cable de cámara','Caja Corvus','Placa electrónica','Módulo Bluetooth','Tablet'];

const S = {
  sesion: leerJSON('sesion'), pant: 'lista', form: null, err: [], loginErr: '', cargando: false,
  red: navigator.onLine, mios: leerJSON('mios') || [], casos: leerJSON('casos') || [], pendientes: 0, pendKb: 0, colaError: '',
  sop: {lista: [], sel: null, error: '', cargando: false, vistos: {}},
};

/* ---------- Utilidades ---------- */
function leerJSON(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } }
function guardarJSON(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ahora = () => new Date().toISOString();
const fechaCorta = iso => { if(!iso) return '—'; const d = new Date(iso); return isNaN(d) ? esc(String(iso)) : d.toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); };
const kbDe = b64 => Math.round(b64.length * 3 / 4 / 1024);
const nuevoId = () => 'pv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

/* ---------- IndexedDB: cola de envíos y borrador ---------- */
const dbP = new Promise((res, rej) => {
  const r = indexedDB.open('preventivo', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('cola', {keyPath:'k', autoIncrement:true}); d.createObjectStore('kv'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function idb(store, mode, fn){
  const d = await dbP;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const colaTodos = () => idb('cola', 'readonly', s => s.getAll());
const colaAgregar = item => idb('cola', 'readwrite', s => s.add(item));
const colaBorrar = k => idb('cola', 'readwrite', s => s.delete(k));
const colaActualizar = item => idb('cola', 'readwrite', s => s.put(item));
const kvLeer = k => idb('kv', 'readonly', s => s.get(k));
const kvGuardar = (k, v) => idb('kv', 'readwrite', s => s.put(v, k));
const kvBorrar = k => idb('kv', 'readwrite', s => s.delete(k));

/* ---------- Servidor ---------- */
async function api(accion, datos, ms){
  if(!CFG.API_URL || CFG.API_URL.indexOf('http') !== 0) throw new Error('Falta configurar la URL del servidor.');
  // ms corta la espera: con señal débil el pedido puede quedar colgado minutos.
  const ctl = ms ? new AbortController() : null, t = ms ? setTimeout(() => ctl.abort(), ms) : 0;
  let r;
  try{
    r = await fetch(CFG.API_URL, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify(Object.assign({accion, token: S.sesion && S.sesion.token}, datos || {}))});
  } finally { clearTimeout(t); }
  let j;
  try{ j = await r.json(); }
  catch(e){ const x = new Error('El servidor respondió con un error' + (r.status !== 200 ? ' (HTTP ' + r.status + ')' : '') + '. Se reintenta solo.'); x.servidor = true; throw x; }
  if(!j.ok){ const e = new Error(j.error || 'Error del servidor.'); e.servidor = true; e.sesionVencida = j.sesionVencida; throw e; }
  return j;
}

/* ---------- Cola ---------- */
let procesando = false;
async function contarCola(){
  const xs = await colaTodos();
  S.pendientes = xs.length; S.pendKb = xs.reduce((a, x) => a + (x.kb || 1), 0);
  const sb = $('#syncbar'); if(sb){ sb.outerHTML = syncbarHTML(); const b = $('#syncbar [data-act]'); if(b) b.onclick = ev => { ev.preventDefault(); accion(b.dataset.act); }; }
}
// Espera tras un error del servidor: 30 s, 1, 2, 4… minutos, hasta 30 min. Evita resubir un video entero cada 30 s.
const esperaTrasError = n => Math.min(30 * 60000, 30000 * Math.pow(2, Math.max(0, n - 1)));
async function procesarCola(forzar){
  if(procesando || guardando || !S.sesion || S.sesion.rol !== 'TECNICO') return;
  procesando = true;
  const trabados = new Set(); // casos cuyo checklist no entró: sus archivos esperan
  try{
    for(const item of await colaTodos()){
      if(trabados.has(item.id)) continue;
      if(!forzar && item.proximo && item.proximo > Date.now()){ if(item.tipo === 'checklist') trabados.add(item.id); continue; }
      try{
        const ms = 60000 + (item.kb || 1) * 20; // 1 min más 20 s por MB
        const r = item.tipo === 'checklist' ? await api('checklist', {checklist: item.payload}, ms) : await api('archivo', {archivo: item.payload}, ms);
        await colaBorrar(item.k);
        actualizarMio(item.id, m => {
          if(item.tipo === 'checklist'){ m.estado = r.estado || m.estado; m.bthValido = r.bthValido; }
          else { m.subidas = [...new Set((m.subidas || []).concat(item.payload.clave))]; if(r.estado) m.estado = r.estado; }
        });
        S.red = true; S.colaError = '';
      }catch(e){
        if(e.sesionVencida){ S.colaError = 'La sesión venció: ingresá de nuevo para terminar de enviar.'; cerrarSesion(false); break; }
        if(!e.servidor){ S.red = false; break; }        // sin conexión: se reintenta después
        item.intentos = (item.intentos || 0) + 1; item.error = e.message; item.proximo = Date.now() + esperaTrasError(item.intentos); await colaActualizar(item);
        if(item.tipo === 'checklist') trabados.add(item.id);
        S.colaError = 'Un envío falló: ' + e.message;
      }
      await contarCola();
    }
  } finally { procesando = false; await contarCola(); if(S.pant === 'lista') render(); }
}
function actualizarMio(id, fn){ const m = S.mios.find(x => x.id === id); if(m){ fn(m); guardarJSON('mios', S.mios); } }
async function refrescarMios(){
  if(!S.sesion || S.sesion.rol !== 'TECNICO') return;
  try{
    const r = await api('mis');
    r.checklists.forEach(c => actualizarMio(c.id, m => { m.estado = c.estado; m.motivo = c.motivo; m.recibidosServidor = c.recibidos; }));
    S.red = true; if(S.pant === 'lista') render();
  }catch(e){ if(e.sesionVencida) cerrarSesion(true); }
}

/* ---------- Sesión ---------- */
async function ingresar(){
  const usuario = $('#lgUser').value.trim().toLowerCase(), pin = $('#lgPin').value;
  S.cargando = true; S.loginErr = ''; render();
  try{
    const r = await api('login', {usuario, pin});
    S.sesion = {token:r.token, usuario:r.usuario, nombre:r.nombre, rol:r.rol, vence:r.vence};
    guardarJSON('sesion', S.sesion); S.pant = 'lista'; S.colaError = '';
    if(S.sesion.rol === 'TECNICO'){ procesarCola(); refrescarMios(); } else cargarSoporte();
  }catch(e){ S.loginErr = e.servidor ? e.message : 'Sin conexión: el ingreso necesita señal.'; }
  S.cargando = false; render();
}
function cerrarSesion(redibujar){ S.sesion = null; localStorage.removeItem('sesion'); S.pant = 'lista'; S.sop.sel = null; if(redibujar !== false) render(); }

/* ---------- BTH ---------- */
// El checklist se abre con un número de BTH bien formado. La búsqueda en el padrón es solo un aviso:
// el servidor vuelve a controlar el BTH contra TABLET al recibir el caso.
const bthListo = f => !!f && /^\d{3,4}$/.test(f.bth || '');
const BTH_ESPERA_MS = 8000;
let bthTimer = 0, bthSeq = 0;
function bthEstadoHTML(f){
  if(!bthListo(f)) return '';
  const nuevo = f.tipo === 'INSTALACION' ? '<br><button class="textbtn" style="padding:4px 0" data-act="bthnuevo">Es un equipo nuevo</button>' : '';
  if(f.bthInfo === 'buscando') return '<div class="ro">Buscando el equipo…</div>';
  if(f.bthInfo === null) return `<div class="ro bad">Ese BTH no figura en el padrón. Revisá la pantalla INFO. Podés seguir cargando: Soporte lo controla.${nuevo}</div>`;
  if(f.bthInfo === 'offline') return '<div class="ro">Sin señal: el BTH se controla al enviar. <button class="textbtn" style="padding:0" data-act="buscarbth">Buscar de nuevo</button></div>';
  if(f.bthInfo && f.bthInfo.nuevo) return '<div class="ro">Equipo nuevo, todavía no figura en el padrón. Soporte lo revisa.</div>';
  if(f.bthInfo) return `<div class="ro">Equipo encontrado. Tipo de tolva: ${esc(f.bthInfo.tolva || 'sin dato')}</div>`;
  return '';
}
function pintarBthEstado(){
  const el = $('#bthEstado'); if(!el || !S.form) return;
  el.innerHTML = bthEstadoHTML(S.form);
  el.querySelectorAll('[data-act]').forEach(b => b.onclick = ev => { ev.preventDefault(); accion(b.dataset.act); });
}
async function buscarBth(){
  const f = S.form; if(!bthListo(f)) return;
  const seq = ++bthSeq, b = f.bth;
  f.bthInfo = 'buscando'; pintarBthEstado();
  let info;
  try{ const r = await api('bth', {bth:b}, BTH_ESPERA_MS); info = r.existe ? {tolva:r.tolva, cam:r.cam} : null; S.red = true; }
  catch(e){ if(e.servidor){ info = undefined; alert(e.message); } else info = 'offline'; }
  if(seq !== bthSeq || S.form !== f || f.bth !== b) return; // el técnico cambió el número o salió del caso
  f.bthInfo = info; pintarBthEstado(); guardarBorrador();
}
function programarBusqueda(){ clearTimeout(bthTimer); bthSeq++; if(bthListo(S.form)) bthTimer = setTimeout(buscarBth, 900); }

/* ---------- Render general ---------- */
function render(){
  const app = $('#app');
  app.classList.toggle('ancho', !!(S.sesion && S.sesion.rol === 'SOPORTE'));
  if(!S.sesion) app.innerHTML = loginHTML();
  else if(S.sesion.rol === 'SOPORTE') app.innerHTML = soporteHTML();
  else if(S.pant === 'form') app.innerHTML = appbar((S.form.tipo ? TIPOS[S.form.tipo] : 'Nuevo trabajo') + (S.form.bth ? ' · B-T-H-' + esc(S.form.bth) : ''), true) + progresoHTML() + '<div class="main">' + formHTML() + '</div>' + syncbarHTML();
  else app.innerHTML = appbar('Mis trabajos') + '<div class="main">' + listaHTML() + '</div>' + syncbarHTML();
  bind();
  if(S.pant === 'form' && bthListo(S.form) && S.form.tipo) iniciarFirma();
}
function appbar(titulo, volver){
  const red = S.red ? '<span class="net">con datos</span>' : '<span class="net off">sin señal</span>';
  const b = volver ? '<button class="iconbtn" data-act="volver" aria-label="Volver"><svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg></button>' : '';
  return `<div class="appbar">${b}<img class="marca" src="logo-corvus-blanco.png" alt="Corvus"><div class="titles"><div class="app-name">Preventivo AGDP${S.sesion ? ' · ' + esc(S.sesion.usuario) : ''}</div><div class="view-name">${titulo}</div></div>${red}</div>`;
}
function syncbarHTML(){
  if(!S.pendientes) return `<div class="syncbar" id="syncbar"><span>Todo enviado</span><span>${S.colaError ? esc(S.colaError) : ''}</span></div>`;
  const reintentar = S.colaError ? ' <button class="textbtn" style="padding:0" data-act="reintentar">Reintentar ahora</button>' : '';
  return `<div class="syncbar" id="syncbar"><span><b>${S.pendientes}</b> envíos pendientes · ${(S.pendKb/1024).toFixed(1)} MB</span><span>${S.colaError ? esc(S.colaError) + reintentar : S.red ? 'enviando…' : 'esperando señal'}</span></div>`;
}
const tag = e => `<span class="tag ${{'EN EL CELULAR':'warn','SIN GUARDAR':'warn',INCOMPLETO:'warn',RECIBIDO:'info',COMPLETO:'info',VALIDADO:'ok',OBSERVADO:'bad'}[e] || ''}">${esc(e)}</span>`;

/* ---------- Ingreso ---------- */
function loginHTML(){
  return appbar('Ingresar') + `<div class="login">
    <img class="logo-login" src="logo-corvus.png" alt="Corvus"><div class="logo">Preventivo AGDP</div><p class="hint">Usuario y clave que te dio Corvus.</p>
    <div class="field"><label for="lgUser">Usuario</label><input type="text" id="lgUser" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
    <div class="field"><label for="lgPin">Clave</label><input type="password" id="lgPin" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
    ${S.loginErr ? `<div class="errors" style="margin:8px 0">${esc(S.loginErr)}</div>` : ''}
    ${S.colaError ? `<div class="errors" style="margin:8px 0">${esc(S.colaError)}</div>` : ''}
    <button class="btn-main" style="margin:14px 0 0;width:100%" data-act="login" ${S.cargando ? 'disabled' : ''}>${S.cargando ? 'Ingresando…' : 'Ingresar'}</button>
    <p class="hint">El primer ingreso necesita señal. Después la sesión dura 30 días y la web abre sin señal.</p></div>`;
}

/* ---------- Técnico: lista ---------- */
function listaHTML(){
  let h = '';
  if(S.casos.length){
    h += `<div class="group"><span>Inconclusos: tocá para completar</span><span>${S.casos.length}</span></div>`;
    S.casos.slice().reverse().forEach(c => {
      h += `<div style="display:flex;align-items:center;border-bottom:1px solid var(--line)"><button class="row" style="border-bottom:0" data-abrir="${esc(c.id)}"><div class="avatar" style="background:var(--warn)">${esc(c.bth || '?')}</div><div class="txt"><div class="t1">B-T-H-${esc(c.bth || 'sin cargar')}</div>
        <div class="t2">${c.tipo ? TIPOS[c.tipo] + ' · ' : ''}Empezado ${fechaCorta(c.inicio)}</div>${c.faltan ? `<div class="t2" style="color:var(--warn)">${esc(c.falta || 'Faltan ' + c.faltan + ' datos.')}</div>` : ''}${tag(c.estado)}</div></button>
        ${c.estado === 'SIN GUARDAR' ? `<button class="textbtn" data-descartar="${esc(c.id)}">Descartar</button>` : ''}</div>`;
    });
  }
  const cerrados = S.mios.filter(m => !S.casos.some(c => c.id === m.id));
  h += `<div class="group"><span>Cerrados</span><span>${cerrados.length}</span></div>`;
  if(!cerrados.length) h += '<p class="hint" style="padding:12px 14px">Todavía no cerraste ninguno.</p>';
  cerrados.slice().reverse().forEach(m => {
    const env = m.claves ? m.claves.filter(k => (m.subidas || []).includes(k)).length : (m.enviados || 0);
    const pct = m.esperados ? Math.round(100 * Math.min(env, m.esperados) / m.esperados) : 0;
    h += `<div class="row"><div class="avatar">${esc(m.bth)}</div><div class="txt"><div class="t1">B-T-H-${esc(m.bth)}</div>
      <div class="t2">${m.tipo ? TIPOS[m.tipo] + ' · ' : ''}${fechaCorta(m.inicio)} · ${Math.min(env, m.esperados)} de ${m.esperados} archivos enviados</div><div class="bar"><i style="width:${pct}%"></i></div>
      ${tag(m.estado)}${m.bthValido === 'NO' ? ' <span class="tag bad">BTH no encontrado</span>' : ''}${m.motivo ? `<div class="t2" style="color:var(--bad)">${esc(m.motivo)}</div>` : ''}</div></div>`;
  });
  return h + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px"><button class="btn-main" style="margin:0;width:100%" data-act="nuevoPrev">+ Preventivo</button><button class="btn-main" style="margin:0;width:100%;background:var(--brand)" data-act="nuevoInst">+ Instalación nueva</button></div><button class="textbtn" data-act="salir">Cerrar sesión</button>`;
}

/* ---------- Técnico: formulario ---------- */
function nuevoForm(tipo){
  S.form = {id: nuevoId(), tipo, r:{}, cap:{}, repuestos:[], inicio: ahora(), gps: '', enviadas:{}};
  S.casos.push({id:S.form.id, tipo, bth:'', inicio:S.form.inicio, estado:'SIN GUARDAR', faltan:0});
  guardarJSON('casos', S.casos);
  S.err = []; S.pant = 'form'; tomarGps(); guardarBorrador();
}
async function abrirCaso(id){
  const f = await kvLeer('caso:' + id);
  if(!f){ alert('No se encontró el caso en este celular.'); return; }
  S.form = f; S.form.enviadas = S.form.enviadas || {}; S.err = []; S.pant = 'form';
  // Un caso que quedó sin respuesta del padrón (sin señal o búsqueda cortada) se vuelve a buscar al abrirlo.
  if(f.bthInfo === 'buscando' || f.bthInfo === 'offline' || f.bthInfo === undefined){ f.bthInfo = undefined; programarBusqueda(); }
  render(); window.scrollTo(0, 0);
}
function resumenCaso(estado){
  const c = S.casos.find(x => x.id === S.form.id); if(!c) return;
  c.bth = S.form.bth || ''; c.tipo = S.form.tipo || ''; c.faltan = bthListo(S.form) && S.form.tipo ? faltantes().length : 0; c.falta = c.faltan ? resumenFalta() : ''; if(estado) c.estado = estado;
  guardarJSON('casos', S.casos);
}
function tomarGps(){
  if(!navigator.geolocation){ S.form.gps = 'sin GPS'; return; }
  const f = S.form;
  navigator.geolocation.getCurrentPosition(
    p => { f.gps = p.coords.latitude.toFixed(6) + ', ' + p.coords.longitude.toFixed(6); guardarBorrador(); const m = $('#metaGps'); if(m) m.textContent = f.gps; },
    () => { f.gps = 'sin permiso de ubicación'; guardarBorrador(); const m = $('#metaGps'); if(m) m.textContent = f.gps; },
    {enableHighAccuracy:true, timeout:30000, maximumAge:120000});
}
let borradorT = null;
function avisoAlmacenamiento(e){
  if(S.avisoEspacio) return; S.avisoEspacio = true;
  alert('El celular no pudo guardar el trabajo (' + (e && e.name || 'error') + '). Liberá espacio y no cierres la app hasta enviarlo.');
}
function guardarBorrador(){ clearTimeout(borradorT); borradorT = setTimeout(() => { if(S.form){ kvGuardar('caso:' + S.form.id, S.form).then(() => { S.avisoEspacio = false; }, avisoAlmacenamiento); resumenCaso(); } }, 300); }

function formHTML(){
  const f = S.form;
  let h = `<div class="meta">Inicio ${fechaCorta(f.inicio)} · GPS <span id="metaGps">${esc(f.gps || 'buscando…')}</span><br>Hora y GPS los toma el celular.</div>`;
  if(!f.tipo) h += `<div class="sec"><h4>Tipo de trabajo <span class="req">*</span></h4><div class="pills" data-tipo="1">${Object.entries(TIPOS).map(([k, v]) => `<button data-v="${k}" aria-pressed="${f.tipo === k}" style="${f.tipo === k ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''}">${v}</button>`).join('')}</div></div>`;
  h += `<div class="sec"><h4>Equipo</h4><div class="field"><label for="bth">Número de BTH: tablet → CONFIGURACION → INFO, Cód. Balanza <span class="req">*</span></label>
    <div class="bthrow"><span>B-T-H-</span><input type="tel" id="bth" inputmode="numeric" maxlength="4" data-f="bth" value="${esc(f.bth || '')}"></div></div>
    <div id="bthEstado">${bthEstadoHTML(f)}</div>`;
  h += '</div>';
  if(!bthListo(f) || !f.tipo) return h + `<p class="hint" style="padding:0 14px">${!f.tipo ? 'Elegí el tipo de trabajo. ' : ''}${!bthListo(f) ? 'Cargá el número de BTH (3 o 4 dígitos).' : ''} Después aparece el checklist.</p>`;

  itemsDe(f.tipo).forEach((it, n) => {
    const r = f.r[it.k];
    h += `<div class="sec"><h4>${n + 1}. ${it.t}</h4><p class="crit">${it.crit}</p>
      <div class="pills" data-item="${it.k}">${['OK','FALLA','NA'].map(v => `<button data-v="${v}" aria-pressed="${r === v}">${v === 'NA' ? 'No aplica' : v === 'FALLA' ? 'Falla' : 'OK'}</button>`).join('')}</div>`;
    if(it.sellado) h += `<div class="field"><label>¿Se selló la caja?</label><select data-f="sellado"><option value="">—</option>${['Sí','No hizo falta'].map(o => `<option ${f.sellado === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    if(it.kg){
      const kg = f.kgFantasma === undefined || f.kgFantasma === '' ? null : Number(f.kgFantasma);
      const nota = kg === null || isNaN(kg) ? 'Ideal: 0 a 20 kg. Aceptable: menos de 40 kg.' : kg < 20 ? 'Ideal.' : kg < 40 ? 'Aceptable.' : 'Fuera de tolerancia: el resultado es Falla.';
      h += `<div class="field"><label>Kg que sumó el neto al abrir y cerrar el tubo <span class="req">*</span></label><input type="number" min="0" inputmode="numeric" data-f="kgFantasma" value="${esc(f.kgFantasma ?? '')}"><div class="hint ${kg !== null && kg >= 40 ? 'warn' : ''}" id="kgNota">${nota}</div></div>`;
    }
    if(it.prueba) h += `<div class="field"><label>Hora de la descarga de prueba <span class="req">*</span></label><input type="text" inputmode="numeric" placeholder="hh:mm" data-f="hora" value="${esc(f.hora || '')}"><div class="hint">Soporte la busca en AGDP Web con esta hora y el BTH.</div></div>`;
    if(r !== 'NA'){
      it.fotos.forEach(([k, lbl]) => {
        const c = f.cap[k];
        h += `<div class="field"><button class="cap ${c ? 'done' : ''}" data-foto="${k}" data-item="${it.k}">${c ? `<img src="data:${c.mime};base64,${c.b64}" alt="">` : '<span class="thumb">cámara</span>'}
          <span><span>${lbl}${r ? ' <span class="req">*</span>' : ''}</span><br><span class="ps">${c ? fechaCorta(c.hora) + ' · ' + c.kb + ' KB · tocar para repetir' : 'Abre la cámara trasera'}</span></span></button></div>`;
      });
      extrasDe(it.k).forEach(k => {
        const c = f.cap[k];
        h += `<div class="field" style="display:flex;gap:8px;align-items:center"><button class="cap done" style="flex:1" data-foto="${k}" data-item="${it.k}"><img src="data:${c.mime};base64,${c.b64}" alt="">
          <span><span>Foto adicional</span><br><span class="ps">${fechaCorta(c.hora)} · ${c.kb} KB · tocar para repetir</span></span></button>
          ${f.enviadas && f.enviadas[k] ? '' : `<button class="textbtn" data-quitar="${k}">Quitar</button>`}</div>`;
      });
      h += `<button class="textbtn" style="padding:4px 0" data-extra="${it.k}">+ Agregar otra foto</button>`;
      if(it.antes){
        const a = it.antes, movia = f[a.campo];
        h += `<div class="field"><label>${a.pregunta} <span class="req">*</span></label><div class="pills" data-campo="${a.campo}">${['SI','NO'].map(v => `<button data-v="${v}" aria-pressed="${movia === v}" style="${movia === v ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''}">${v === 'SI' ? 'Sí' : 'No'}</button>`).join('')}</div>
          ${movia === 'SI' ? '<p class="hint warn">Subí dos videos: uno con el problema y otro con el arreglo.</p>' : ''}</div>`;
        if(movia === 'SI') h += videoHTML(f, it, a.video, a.txt);
      }
      if(it.video){
        const c = f.cap[it.video];
        h += `<div class="field"><button class="cap ${c ? 'done' : ''}" data-video="${it.video}" data-item="${it.k}"><span class="thumb">video</span>
          <span><span>${it.antes && f[it.antes.campo] === 'SI' ? it.antes.txtDespues : (it.videoTxt || 'Video de hasta 15 s')}${r ? ' <span class="req">*</span>' : ''}</span><br><span class="ps">${c ? fechaCorta(c.hora) + ' · ' + (c.kb / 1024).toFixed(1) + ' MB · tocar para repetir' : 'Graba en baja resolución, sin audio'}</span></span></button>
          ${CFG.WHATSAPP_SOPORTE ? `<a class="wa" target="_blank" rel="noopener" href="https://wa.me/${esc(CFG.WHATSAPP_SOPORTE)}?text=${encodeURIComponent('Video preventivo ' + f.id + ' B-T-H-' + (f.bth || ''))}">Si el video no sube, mandalo por WhatsApp a Soporte</a>` : ''}</div>`;
      }
    }
    h += '</div>';
  });
  h += `<div class="sec"><h4>Repuestos Corvus utilizados</h4><p class="crit">Marcá solo los repuestos de Corvus que se cambiaron. Si no se cambió nada, dejalo vacío.${f.r.carga === 'FALLA' ? ' <span class="req">La carga dio Falla: marcá lo que se cambió.</span>' : ''}</p>
    <div class="checks">${REPUESTOS.map(x => `<label><input type="checkbox" data-rep="${esc(x)}" ${f.repuestos.includes(x) ? 'checked' : ''}> ${esc(x)}</label>`).join('')}</div></div>`;
  const hayFalla = Object.values(f.r).includes('FALLA');
  h += `<div class="sec"><h4>Observaciones</h4><div class="field"><label>Qué falló y qué se hizo ${hayFalla ? '<span class="req">*</span>' : ''}</label><textarea data-f="obs">${esc(f.obs || '')}</textarea></div></div>`;
  h += `<div class="sec"><h4>Conformidad del cliente</h4><div class="field"><label>Nombre y apellido de quien recibe <span class="req">*</span></label><input type="text" data-f="recibe" value="${esc(f.recibe || '')}"></div>
    <div class="field"><label>Firma <span class="req">*</span></label><canvas class="sig" id="sig"></canvas><div class="sigrow"><span class="hint" id="sigHint">${f.firma ? 'Firma cargada' : 'Firmar con el dedo'}</span><button class="textbtn" data-act="borrarfirma">Borrar</button></div></div></div>`;
  if(S.err.length) h += `<div class="errors">${S.err.map(esc).join('<br>')}</div>`;
  return h + `<div id="zonaGuardar">${botonHTML()}</div>`;
}

// Cada requisito lleva su sección (sec) y el dato que falta (dato), para resumir por punto y no por cantidad de datos.
const SECCIONES = {tipo:'el tipo de trabajo', equipo:'el número de BTH', rep:'los repuestos', obs:'las observaciones', conf:'la conformidad del cliente'};
function requisitos(){
  const f = S.form, req = [];
  const add = (ok, sec, dato, txt) => req.push({ok: !!ok, sec, dato, txt});
  add(f.tipo, 'tipo', 'el tipo de trabajo', 'Falta elegir el tipo de trabajo.');
  add(bthListo(f), 'equipo', 'el número de BTH', 'Equipo: falta el número de BTH.');
  if(!bthListo(f) || !f.tipo) return req;
  itemsDe(f.tipo).forEach((it, i) => {
    const n = i + 1, r = f.r[it.k], p = `Punto ${n} (${it.t})`, a = (ok, dato) => add(ok, n, dato, `${p}: falta ${dato}.`);
    a(r, 'el resultado');
    if(r === 'NA') return;
    it.fotos.forEach(([k, lbl]) => a(f.cap[k], (/^foto/i.test(lbl) ? 'la ' : '') + lbl.charAt(0).toLowerCase() + lbl.slice(1)));
    if(it.antes){
      a(f[it.antes.campo], 'responder si los kg se movían');
      if(f[it.antes.campo] === 'SI') a(f.cap[it.antes.video], 'el video de antes de arreglar');
    }
    if(it.video) a(f.cap[it.video], `el video${it.antes && f[it.antes.campo] === 'SI' ? ' de después de arreglar' : ''}`);
    if(it.kg){
      const kg = Number(f.kgFantasma);
      a(!(f.kgFantasma === undefined || f.kgFantasma === '' || isNaN(kg) || kg < 0), 'cargar los kg que sumó el neto');
      if(r === 'OK' && kg >= 40) add(false, n, 'corregir el resultado (con 40 kg o más es Falla)', `${p}: con 40 kg o más el resultado es Falla.`);
    }
    if(it.prueba) a(/^\d{1,2}:\d{2}$/.test(f.hora || ''), 'la hora de la descarga (hh:mm)');
  });
  if(Object.values(f.r).includes('FALLA')) add((f.obs || '').trim(), 'obs', 'describir la falla en Observaciones', 'Hay una falla: describila en Observaciones.');
  if(f.r.carga === 'FALLA') add(f.repuestos.length, 'rep', 'marcar en Repuestos lo que se cambió', 'Carga de la tablet: marcá en Repuestos lo que se cambió.');
  add((f.recibe || '').trim(), 'conf', 'el nombre de quien recibe', 'Conformidad: falta el nombre de quien recibe.');
  add(f.firma, 'conf', 'la firma del cliente', 'Conformidad: falta la firma.');
  return req;
}
const faltantes = () => requisitos().filter(r => !r.ok).map(r => r.txt);
const unirY = xs => xs.length < 2 ? (xs[0] || '') : xs.slice(0, -1).join(', ') + ' y ' + xs[xs.length - 1];
function rangos(ns){
  const out = []; let i = 0;
  while(i < ns.length){ let j = i; while(j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    if(j - i >= 2) out.push(ns[i] + ' a ' + ns[j]); else for(let k = i; k <= j; k++) out.push(String(ns[k]));
    i = j + 1; }
  return out;
}
// Resumen corto de lo que falta: con uno o dos datos los nombra; con más, nombra los puntos y secciones.
function resumenFalta(){
  const m = requisitos().filter(r => !r.ok); if(!m.length) return '';
  const lugar = s => typeof s === 'number' ? 'en el punto ' + s : s === 'conf' ? 'en la conformidad' : '';
  // Si falta el resultado, falta el punto entero: se nombra el punto y no sus datos sueltos.
  if(m.length <= 2 && !m.some(r => r.dato === 'el resultado')) return 'Falta ' + unirY(m.map(r => (r.dato + ' ' + lugar(r.sec)).trim())) + '.';
  const nums = [...new Set(m.filter(r => typeof r.sec === 'number').map(r => r.sec))].sort((a, b) => a - b);
  const otras = [...new Set(m.filter(r => typeof r.sec !== 'number').map(r => r.sec))].map(s => SECCIONES[s]);
  const partes = [];
  if(nums.length){ const rs = rangos(nums); partes.push((nums.length === 1 ? 'el punto ' : 'los puntos ') + (otras.length ? rs.join(', ') : unirY(rs))); }
  return 'Falta completar ' + unirY(partes.concat(otras)) + '.';
}
function progresoHTML(){
  if(!bthListo(S.form) || !S.form.tipo) return '<div class="prog" id="prog"><div class="prog-top"><span>Cargá el equipo para empezar</span><b>0%</b></div><div class="bar big"><i style="width:0"></i></div></div>';
  const req = requisitos(), ok = req.filter(r => r.ok).length, pct = Math.round(100 * ok / req.length);
  return `<div class="prog" id="prog"><div class="prog-top"><span>${pct === 100 ? 'Checklist completo' : 'Progreso del checklist'}</span><b>${ok} de ${req.length}</b></div><div class="bar big"><i style="width:${pct}%;${pct < 100 ? 'background:var(--accent)' : ''}"></i></div></div>`;
}
function botonHTML(){
  if(!bthListo(S.form) || !S.form.tipo) return '';
  const n = faltantes().length, red = S.red ? 'y enviar' : 'en el celular';
  if(!n) return `<button class="btn-main" data-act="guardar">Cerrar caso: guardar ${red}</button>`;
  return `<p class="hint warn" style="margin:14px 14px 0;font-weight:600">${esc(resumenFalta())}</p>
    <button class="btn-main" style="background:var(--warn)" data-act="guardar">Guardar incompleto</button>
    <p class="hint" style="margin:0 14px">Queda en Inconclusos y lo podés completar después. Se cierra cuando no falte nada.</p>
    <button class="textbtn" style="display:block;margin:0 auto 16px" data-act="verfalta">Ver qué falta</button>`;
}
function notaKg(){
  const n = $('#kgNota'); if(!n) return;
  const v = S.form.kgFantasma, kg = v === undefined || v === '' ? null : Number(v);
  n.textContent = kg === null || isNaN(kg) ? 'Ideal: 0 a 20 kg. Aceptable: menos de 40 kg.' : kg < 20 ? 'Ideal.' : kg < 40 ? 'Aceptable.' : 'Fuera de tolerancia: el resultado es Falla.';
  n.className = 'hint' + (kg !== null && kg >= 40 ? ' warn' : '');
}
function refrescarProgreso(){
  notaKg();
  const p = $('#prog'); if(p) p.outerHTML = progresoHTML();
  const z = $('#zonaGuardar'); if(z){ z.innerHTML = botonHTML(); z.querySelectorAll('[data-act]').forEach(b => b.onclick = ev => { ev.preventDefault(); accion(b.dataset.act); }); }
  guardarBorrador();
}

/* ---------- Captura de fotos ---------- */
function elegirArchivo(accept, capture){
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; if(capture) i.setAttribute('capture', capture);
    i.style.display = 'none'; document.body.appendChild(i);
    i.onchange = () => { res(i.files[0] || null); i.remove(); }; i.click();
  });
}
async function comprimirFoto(file, max = 1280, calidad = 0.75){
  const url = URL.createObjectURL(file);
  try{
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', calidad).split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}
async function tomarFoto(clave, item){
  const file = await elegirArchivo('image/*', 'environment');
  if(!file) return;
  let b64;
  try{ b64 = await comprimirFoto(file); }
  catch(e){ b64 = ''; }
  if(!b64 || !S.form){ if(S.form) alert('No se pudo leer la foto. Sacala de nuevo.'); return; }
  S.form.cap[clave] = {tipo:'foto', mime:'image/jpeg', b64, kb: kbDe(b64), hora: ahora(), item};
  render(); guardarBorrador();
}

/* ---------- Video ---------- */
const blobAB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function videoDeArchivo(clave, item){
  const f = S.form;
  const file = await elegirArchivo('video/*', 'environment');
  if(!file) return;
  if(!file.size){ alert('El video quedó vacío. Grabalo de nuevo.'); return; }
  if(file.size > 25 * 1024 * 1024){ alert('El video pesa ' + (file.size / 1048576).toFixed(0) + ' MB. Grabá uno más corto (10 a 15 s).'); return; }
  const b64 = await blobAB64(file).catch(() => '');
  if(!b64){ alert('No se pudo leer el video. Grabalo de nuevo.'); return; }
  if(S.form !== f) return;
  f.cap[clave] = {tipo:'video', mime: file.type || 'video/mp4', b64, kb: kbDe(b64), hora: ahora(), item};
  render(); guardarBorrador();
}
function sinCamaraApp(){
  S.sinCamara = true;
  alert('No se pudo usar la cámara dentro de la app. Tocá de nuevo el botón del video para grabar con la cámara del celular (10 a 15 s).');
}
async function grabarVideo(clave, item){
  const mime = window.MediaRecorder && ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
  if(S.sinCamara || !mime || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return videoDeArchivo(clave, item);
  let stream = null;
  try{ stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment', width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:20}}, audio:false}); }
  catch(e){ return sinCamaraApp(); }
  const f = S.form;
  const ov = document.createElement('div'); ov.className = 'rec';
  ov.innerHTML = '<video autoplay playsinline muted></video><div class="ctrl"><span id="recT">Listo para grabar</span><button id="recBtn" style="background:#c0392b;color:#fff">Grabar</button><button id="recCancel">Cancelar</button></div>';
  document.body.appendChild(ov);
  ov.querySelector('video').srcObject = stream;
  let rec = null, partes = [], t0 = 0, timer = null, cancelado = false;
  const cerrar = () => { clearInterval(timer); stream.getTracks().forEach(t => t.stop()); ov.remove(); };
  const detener = () => { if(rec && rec.state === 'recording') rec.stop(); };
  ov.querySelector('#recCancel').onclick = () => { cancelado = true; detener(); cerrar(); };
  ov.querySelector('#recBtn').onclick = () => {
    const btn = ov.querySelector('#recBtn');
    if(rec){ detener(); return; }
    try{ rec = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 600000}); }
    catch(e){ cerrar(); return sinCamaraApp(); }
    rec.onerror = () => { cancelado = true; cerrar(); sinCamaraApp(); };
    rec.ondataavailable = e => { if(e.data.size) partes.push(e.data); };
    rec.onstop = async () => {
      clearInterval(timer);
      if(cancelado) return;
      const blob = new Blob(partes, {type: mime.split(';')[0]});
      const b64 = blob.size ? await blobAB64(blob).catch(() => '') : '';
      cerrar();
      if(!b64){ alert('El video quedó vacío. Grabalo de nuevo.'); return; }
      if(S.form !== f) return;
      f.cap[clave] = {tipo:'video', mime: mime.split(';')[0], b64, kb: kbDe(b64), hora: ahora(), item};
      render(); guardarBorrador();
    };
    rec.start(1000); t0 = Date.now(); btn.textContent = 'Detener';
    timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); ov.querySelector('#recT').textContent = 'Grabando ' + s + ' s de 15'; if(s >= 15) detener(); }, 250);
  };
}

/* ---------- Firma ---------- */
function iniciarFirma(){
  const c = $('#sig'); if(!c) return;
  const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1f2328';
  if(S.form.firma){ const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height); im.src = 'data:image/png;base64,' + S.form.firma; }
  let abajo = false, movs = 0;
  const pos = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  c.onpointerdown = e => { abajo = true; movs = 0; c.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  c.onpointermove = e => { if(!abajo) return; movs++; ctx.lineTo(...pos(e)); ctx.stroke(); };
  c.onpointercancel = () => { abajo = false; };
  c.onpointerup = () => { if(!abajo) return; abajo = false; if(movs < 3 && !S.form.firma) return; S.form.firma = c.toDataURL('image/png').split(',')[1]; S.form.firmaHora = ahora(); $('#sigHint').textContent = 'Firma cargada'; refrescarProgreso(); };
}

function videoHTML(f, it, clave, txt){
  const c = f.cap[clave];
  return `<div class="field"><button class="cap ${c ? 'done' : ''}" data-video="${clave}" data-item="${it.k}"><span class="thumb">video</span>
    <span><span>${txt} <span class="req">*</span></span><br><span class="ps">${c ? fechaCorta(c.hora) + ' · ' + (c.kb / 1024).toFixed(1) + ' MB · tocar para repetir' : 'Graba en baja resolución, sin audio'}</span></span></button></div>`;
}

/* ---------- Fotos adicionales ---------- */
// Clave de una foto adicional: <ítem>x<n>, por ejemplo conecx2.
function extrasDe(item){ const re = new RegExp('^' + item + 'x[0-9]+$'); return Object.keys(S.form.cap).filter(k => re.test(k)).sort((a, b) => Number(a.split('x').pop()) - Number(b.split('x').pop())); }
function nuevaExtra(item){ const ns = extrasDe(item).map(k => Number(k.split('x').pop())); return item + 'x' + ((ns.length ? Math.max(...ns) : 1) + 1); }
function quitarExtra(k){ const cap = Object.assign({}, S.form.cap); Reflect.deleteProperty(cap, k); S.form.cap = cap; render(); guardarBorrador(); }

/* ---------- Guardar ---------- */
function clavesEsperadas(){
  const f = S.form, ks = [];
  itemsDe(f.tipo).forEach(it => { if(f.r[it.k] === 'NA') return; it.fotos.forEach(([k]) => ks.push(k)); extrasDe(it.k).forEach(k => ks.push(k)); if(it.antes && f[it.antes.campo] === 'SI') ks.push(it.antes.video); if(it.video) ks.push(it.video); });
  ks.push('firma');
  return ks;
}
let guardando = false;
async function guardar(){
  if(guardando || !S.form) return;
  guardando = true;
  clearTimeout(borradorT);
  try{ await guardarCaso(); }
  catch(e){ avisoAlmacenamiento(e); }
  finally { guardando = false; }
  if(!S.form){ await contarCola(); procesarCola(); }
}
async function guardarCaso(){
  const f = S.form, falta = faltantes(), parcial = falta.length > 0;
  if(parcial && !confirm(resumenFalta() + '\n\n- ' + falta.join('\n- ') + '\n\n¿Guardar incompleto? Queda en Inconclusos para terminarlo después.')) return;
  // Solo se manda lo nuevo o lo que se volvió a capturar desde el último guardado.
  const archivos = Object.entries(f.cap).map(([clave, c]) => ({clave, c}));
  if(f.firma) archivos.push({clave:'firma', c:{tipo:'firma', mime:'image/png', b64:f.firma, kb:kbDe(f.firma), hora:f.firmaHora || f.inicio, item:'conformidad'}});
  const claves = clavesEsperadas();
  // Solo sube lo esperado (un ítem pasado a No aplica no manda sus fotos) y lo nuevo o vuelto a capturar.
  const nuevos = archivos.filter(a => claves.includes(a.clave) && f.enviadas[a.clave] !== a.c.hora);
  const checklist = {id:f.id, tipo:f.tipo, bth:f.bth, inicio:f.inicio, gps:f.gps, r:Object.fromEntries(itemsDe(f.tipo).map(it => [it.k, f.r[it.k] || ''])),
    sellado:f.sellado || '', conecMovia:f.conecMovia || '', kgFantasma:f.kgFantasma ?? '', hora:f.hora || '', repuestos:f.repuestos, obs:f.obs || '', recibe:f.recibe || '',
    claves, parcial, faltantes: falta};
  let m = S.mios.find(x => x.id === f.id);
  if(!m){ m = {id:f.id, bth:f.bth, inicio:f.inicio, subidas:[]}; S.mios.push(m); }
  m.bth = f.bth; m.tipo = f.tipo; m.esperados = claves.length; m.claves = claves; m.estado = parcial ? 'INCOMPLETO' : 'EN EL CELULAR';
  guardarJSON('mios', S.mios);
  // Todo el envío entra en una sola transacción: si falta espacio, no queda un caso a medias en la cola.
  const items = [{tipo:'checklist', id:f.id, payload:checklist, kb:2}].concat(nuevos.map(a =>
    ({tipo:'archivo', id:f.id, kb:a.c.kb, payload:{id:f.id, clave:a.clave, item:a.c.item, tipo:a.c.tipo, mime:a.c.mime, capturado:a.c.hora, datos:a.c.b64}})));
  await idb('cola', 'readwrite', st => { items.forEach(x => st.add(x)); });
  nuevos.forEach(a => { f.enviadas[a.clave] = a.c.hora; });
  if(parcial){ await kvGuardar('caso:' + f.id, f); resumenCaso('INCOMPLETO'); }
  else { await kvBorrar('caso:' + f.id); S.casos = S.casos.filter(c => c.id !== f.id); guardarJSON('casos', S.casos); }
  S.form = null; S.err = []; S.pant = 'lista'; render(); window.scrollTo(0, 0);
}

/* ---------- Soporte ---------- */
async function cargarSoporte(){
  S.sop.cargando = true; S.sop.error = ''; render();
  try{ const r = await api('listar'); S.sop.lista = r.checklists; S.red = true; if(!S.sop.sel && r.checklists[0]) S.sop.sel = r.checklists[0].ID; }
  catch(e){ if(e.sesionVencida){ cerrarSesion(); return; } S.sop.error = e.servidor ? e.message : 'Sin conexión: Soporte necesita señal.'; }
  S.sop.cargando = false; render();
}
function soporteHTML(){
  const L = S.sop.lista, sel = L.find(c => c.ID === S.sop.sel);
  let h = `<div class="appbar"><img class="marca" src="logo-corvus-blanco.png" alt="Corvus"><div class="titles"><div class="app-name">Preventivo AGDP · ${esc(S.sesion.usuario)} · Soporte</div><div class="view-name">Validación de preventivos e instalaciones</div></div>
    <button class="iconbtn" data-act="recargar">Actualizar</button><button class="iconbtn" data-act="salir">Salir</button></div>`;
  if(S.sop.error) h += `<div class="errors">${esc(S.sop.error)}</div>`;
  if(S.sop.cargando) h += '<p class="hint" style="padding:10px 14px">Cargando…</p>';
  h += '<div class="valgrid"><div class="list">';
  ['COMPLETO','RECIBIDO','INCOMPLETO','OBSERVADO','VALIDADO'].forEach(est => {
    const g = L.filter(c => c.ESTADO === est); if(!g.length) return;
    h += `<div class="group"><span>${est}</span><span>${g.length}</span></div>`;
    g.forEach(c => { h += `<button class="row" data-sel="${esc(c.ID)}" style="${sel && sel.ID === c.ID ? 'background:var(--accent-soft)' : ''}"><div class="avatar">${esc(c.BTH)}</div><div class="txt"><div class="t1">B-T-H-${esc(c.BTH)}${c.BTH_VALIDO === 'NO' ? ' <span class="tag bad">no existe</span>' : ''}</div><div class="t2">${TIPOS[c.TIPO_TRABAJO] || 'Preventivo'} · ${esc(c.USUARIO_AGDP || '—')} · ${esc(c.TECNICO)}</div><div class="t2">Prueba ${esc(c.HORA_PRUEBA || '—')} · ${c.ARCHIVOS_RECIBIDOS} de ${c.ARCHIVOS_ESPERADOS} archivos</div></div></button>`; });
  });
  if(!L.length && !S.sop.cargando) h += '<p class="hint" style="padding:12px 14px">No hay checklists.</p>';
  h += '</div><div class="det">';
  if(sel){
    h += `<h3 style="margin-top:0">B-T-H-${esc(sel.BTH)} ${tag(sel.ESTADO)} <span class="tag info">${TIPOS[sel.TIPO_TRABAJO] || 'Preventivo'}</span></h3><p class="hint">${esc(sel.USUARIO_AGDP || 'BTH no encontrado en TABLET')} · ${esc(sel.TIPO_TOLVA || '—')} · técnico ${esc(sel.TECNICO)} · inicio ${fechaCorta(sel.INICIO)} · GPS ${esc(sel.GPS)} · ${esc(sel.ID)}</p>`;
    const map = {icaja:'R_INST_CAJA',itab:'R_INST_TABLET',isens:'R_INST_SENSOR',icabl:'R_INST_CABLEADO',conec:'R_CONECTORES',deriv:'R_DERIVADORA',bal:'R_BALANZA',fant:'R_FANTASMA',sens:'R_SENSOR',desc:'R_DESCARGA',carga:'R_CARGA'};
    const tipoSel = sel.TIPO_TRABAJO || 'PREVENTIVO';
    itemsDe(tipoSel).forEach(it => { const v = sel[map[it.k]] || ''; h += `<div class="evrow"><span>${it.t}</span><span>${v === 'OK' ? '<span class="tag ok">OK</span>' : v === 'FALLA' ? '<span class="tag bad">Falla</span>' : v === 'NA' ? '<span class="tag">No aplica</span>' : '<span class="tag warn">sin responder</span>'}</span></div>`; });
    h += `<div class="evrow"><span>Peso fantasma</span><span>${sel.KG_FANTASMA === '' || sel.KG_FANTASMA === undefined ? '—' : esc(sel.KG_FANTASMA) + ' kg'}</span></div>
      <div class="evrow"><span>Kg se movían al mover el cable azul</span><span>${sel.CONEC_KG_SE_MOVIAN === 'SI' ? '<span class="tag warn">Sí: hay video antes y después</span>' : esc(sel.CONEC_KG_SE_MOVIAN || '—')}</span></div>
      <div class="evrow"><span>Caja derivadora sellada</span><span>${esc(sel.SELLADO || '—')}</span></div>
      <div class="evrow"><span>Repuestos</span><span>${esc(sel.REPUESTOS || 'ninguno')}</span></div>
      <div class="evrow"><span>Conformidad</span><span>${esc(sel.RECIBE)}</span></div>`;
    if(sel.ESTADO === 'INCOMPLETO' && sel.FALTANTES) h += `<div class="errors" style="margin:10px 0"><b>Guardado incompleto. Falta:</b><br>${esc(sel.FALTANTES).replace(/\n/g, '<br>')}</div>`;
    if(sel.OBS) h += `<p class="hint">Observaciones: ${esc(sel.OBS)}</p>`;
    h += '<div class="galeria">' + sel.archivos.map(a => {
      const v = S.sop.vistos[a.fileId];
      const cont = !v ? `<button data-ver="${esc(a.fileId)}">Ver ${esc(a.tipo)} (${Math.round(a.bytes / 1024)} KB)</button>` : v === 'cargando' ? '<button disabled>Cargando…</button>' :
        !/^(image|video)\/[a-z0-9.+-]+$/.test(v.mime || '') ? '<p class="hint">Formato no previsualizable.</p>' :
        v.mime.startsWith('video') ? `<video controls playsinline src="data:${v.mime};base64,${v.datos}"></video>` : `<img src="data:${v.mime};base64,${v.datos}" alt="">`;
      return `<div class="ga">${cont}${esc(a.clave)} · ${esc(a.item)}</div>`;
    }).join('') + '</div>';
    if(sel.CARPETA_URL) h += `<p class="hint"><a href="${esc(sel.CARPETA_URL)}" target="_blank" rel="noopener">Abrir la carpeta en Drive</a> (necesita acceso con la cuenta dueña)</p>`;
    h += `<div class="webbox"><div class="wt">Paso de Soporte en AGDP Web</div><ol style="font-size:.9rem;margin:0;padding-left:20px">
      <li>Abrir las descargas de ${esc(sel.USUARIO_AGDP || 'el usuario del BTH')} y filtrar por el día de la prueba.</li>
      <li>Buscar la descarga con destino PREVENTIVO cerca de las ${esc(sel.HORA_PRUEBA || '—')}.</li>
      <li>Confirmar el ícono de TIPO: Descarga automatica. (estado 3). Si dice Descarga manual en balanza. (28), el sensor no disparó.</li>
      <li>Confirmar que la posición coincide con el GPS del checklist.</li></ol></div>`;
    if(sel.MOTIVO_OBS) h += `<div class="errors" style="margin:10px 0">Observado: ${esc(sel.MOTIVO_OBS)}</div>`;
    if(sel.ESTADO === 'VALIDADO') h += `<div class="okmsg">Validado por ${esc(sel.VALIDO)}: descarga ${esc(sel.ID_DESCARGA_WEB)}.</div>`;
    else if(sel.ESTADO === 'INCOMPLETO') h += '<p class="hint">El técnico todavía no cerró el caso: se valida cuando lo complete.</p>';
    else {
      const completo = sel.ESTADO === 'COMPLETO' || (sel.ESTADO === 'OBSERVADO' && Number(sel.ARCHIVOS_RECIBIDOS) >= Number(sel.ARCHIVOS_ESPERADOS));
      h += `<div class="field"><label>ID de la descarga en AGDP Web</label><input type="text" id="idDesc"></div>
        <div class="field"><label>Motivo, si se observa</label><textarea id="motivo"></textarea></div>
        <div class="btnrow"><button class="btn ok" data-act="validar" ${completo ? '' : 'disabled'}>Validar</button><button class="btn bad" data-act="observar">Observar</button></div>
        <p class="hint">${completo ? 'Validar exige el ID de la descarga encontrada.' : 'Faltan archivos por llegar: se valida cuando esté COMPLETO.'}</p>`;
    }
  }
  return h + '</div></div>';
}
async function verArchivo(fileId){
  S.sop.vistos[fileId] = 'cargando'; render();
  try{ const r = await api('ver', {fileId}); S.sop.vistos[fileId] = {mime:r.mime, datos:r.datos}; }
  catch(e){ delete S.sop.vistos[fileId]; if(e.sesionVencida) return cerrarSesion(); S.sop.error = e.message; }
  render();
}
async function resolver(resultado){
  const id = S.sop.sel, idDescarga = ($('#idDesc') || {}).value || '', motivo = ($('#motivo') || {}).value || '';
  try{ await api('validar', {id, resultado, idDescarga, motivo}); await cargarSoporte(); }
  catch(e){ if(e.sesionVencida) return cerrarSesion(); S.sop.error = e.message; render(); }
}

/* ---------- Eventos ---------- */
function bind(){
  $$('[data-act]').forEach(b => b.onclick = ev => { ev.preventDefault(); accion(b.dataset.act); });
  const pin = $('#lgPin'); if(pin) pin.onkeydown = e => { if(e.key === 'Enter') ingresar(); };
  $$('[data-sel]').forEach(b => b.onclick = () => { S.sop.sel = b.dataset.sel; S.sop.error = ''; render(); });
  $$('[data-ver]').forEach(b => b.onclick = () => verArchivo(b.dataset.ver));
  $$('[data-abrir]').forEach(b => b.onclick = () => abrirCaso(b.dataset.abrir));
  $$('[data-descartar]').forEach(b => b.onclick = async () => {
    if(!confirm('¿Descartar este trabajo? Nunca se guardó: se pierde lo cargado en el celular.')) return;
    await kvBorrar('caso:' + b.dataset.descartar); S.casos = S.casos.filter(c => c.id !== b.dataset.descartar); guardarJSON('casos', S.casos); render();
  });
  $$('[data-extra]').forEach(b => b.onclick = () => tomarFoto(nuevaExtra(b.dataset.extra), b.dataset.extra));
  $$('[data-quitar]').forEach(b => b.onclick = () => quitarExtra(b.dataset.quitar));
  $$('.pills[data-campo]').forEach(p => p.querySelectorAll('button').forEach(b => b.onclick = () => { S.form[p.dataset.campo] = b.dataset.v; render(); guardarBorrador(); }));
  $$('.pills[data-tipo]').forEach(p => p.querySelectorAll('button').forEach(b => b.onclick = () => { S.form.tipo = b.dataset.v; render(); guardarBorrador(); }));
  $$('.pills[data-item]').forEach(p => p.querySelectorAll('button').forEach(b => b.onclick = () => { S.form.r[p.dataset.item] = b.dataset.v; render(); guardarBorrador(); }));
  $$('[data-foto]').forEach(b => b.onclick = () => tomarFoto(b.dataset.foto, b.dataset.item));
  $$('[data-video]').forEach(b => b.onclick = () => grabarVideo(b.dataset.video, b.dataset.item));
  $$('[data-rep]').forEach(i => i.onchange = () => {
    const s = new Set(S.form.repuestos); i.checked ? s.add(i.dataset.rep) : s.delete(i.dataset.rep);
    S.form.repuestos = REPUESTOS.filter(x => s.has(x)); refrescarProgreso();
  });
  $$('[data-f]').forEach(i => {
    const k = i.dataset.f;
    i.oninput = () => {
      if(k !== 'bth'){ S.form[k] = i.value; return refrescarProgreso(); }
      const antes = bthListo(S.form), v = i.value.replace(/\D/g, '');
      if(v === S.form.bth){ i.value = v; return; }
      S.form.bth = v; i.value = v; S.form.bthInfo = undefined; programarBusqueda();
      if(antes !== bthListo(S.form)){ render(); const n = $('#bth'); if(n){ n.focus(); n.setSelectionRange(v.length, v.length); } }
      else { pintarBthEstado(); refrescarProgreso(); }
    };
    if(i.tagName === 'SELECT') i.onchange = () => { S.form[k] = i.value; render(); guardarBorrador(); };
  });
}
async function accion(a){
  if(a === 'login') return ingresar();
  if(a === 'salir'){ if(S.pendientes && !confirm('Hay envíos pendientes. Se envían cuando vuelvas a ingresar. ¿Cerrar sesión?')) return; return cerrarSesion(); }
  if(a === 'nuevoPrev' || a === 'nuevoInst'){ nuevoForm(a === 'nuevoPrev' ? 'PREVENTIVO' : 'INSTALACION'); render(); window.scrollTo(0, 0); return; }
  if(a === 'volver'){ clearTimeout(borradorT); clearTimeout(bthTimer); bthSeq++; await kvGuardar('caso:' + S.form.id, S.form).catch(avisoAlmacenamiento); resumenCaso(); S.pant = 'lista'; S.form = null; return render(); }
  if(a === 'buscarbth'){ clearTimeout(bthTimer); return buscarBth(); }
  if(a === 'verfalta'){ S.err = faltantes(); render(); const e = $('.errors'); if(e) e.scrollIntoView({block:'center'}); return; }
  if(a === 'bthnuevo'){ S.form.bthInfo = {tolva:'', cam:false, nuevo:true}; pintarBthEstado(); guardarBorrador(); return; }
  if(a === 'borrarfirma'){ S.form.firma = null; S.form.firmaHora = null; render(); guardarBorrador(); return; }
  if(a === 'guardar') return guardar();
  if(a === 'reintentar'){ S.colaError = ''; return procesarCola(true); }
  if(a === 'recargar') return cargarSoporte();
  if(a === 'validar') return resolver('VALIDADO');
  if(a === 'observar') return resolver('OBSERVADO');
}

/* ---------- Arranque ---------- */
function pintarRed(){
  if(S.pant === 'lista' && !S.form) return render();
  const n = $('.appbar .net'); if(n) n.outerHTML = S.red ? '<span class="net">con datos</span>' : '<span class="net off">sin señal</span>';
  contarCola();
}
window.addEventListener('online', () => { S.red = true; procesarCola(true); refrescarMios(); pintarRed(); });
window.addEventListener('offline', () => { S.red = false; pintarRed(); });
// Pide que el sistema no borre lo guardado en el celular (iOS puede vaciarlo si no se usa).
if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
setInterval(() => { if(navigator.onLine) procesarCola(); }, 30000);
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => {
  const b = await kvLeer('borrador').catch(() => null);
  if(b && b.id){ b.enviadas = b.enviadas || {}; await kvGuardar('caso:' + b.id, b); await kvBorrar('borrador');
    if(!S.casos.some(c => c.id === b.id)){ S.casos.push({id:b.id, bth:b.bth || '', inicio:b.inicio, estado:'SIN GUARDAR', faltan:0}); guardarJSON('casos', S.casos); } }
  render(); await contarCola();
  if(S.sesion && S.sesion.rol === 'TECNICO'){ procesarCola(); refrescarMios(); }
  if(S.sesion && S.sesion.rol === 'SOPORTE') cargarSoporte();
})();
