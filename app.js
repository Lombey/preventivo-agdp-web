/* Preventivo AGDP: web instalable del checklist pre-campaña.
 * Técnico: carga el checklist con o sin señal; la cola lo envía a Apps Script cuando hay conexión.
 * Soporte: lista y valida. El rol lo define el servidor al ingresar. */
'use strict';

const CFG = window.PREVENTIVO_CONFIG;
const ITEMS = [
  {k:'ident', t:'1. Identidad del equipo', crit:'Cód. Balanza y S/N Balanza de la pantalla INFO coinciden con el BTH cargado.', fotos:[['info','Foto de la pantalla INFO']]},
  {k:'conec', t:'2. Conectores de la caja', crit:'Conectores de energía y de celdas en buen estado. Al manipular el cable de celdas, el peso de la tablet no se mueve.', fotos:[['conec','Foto de la caja montada y sus fichas']]},
  {k:'deriv', t:'3. Caja derivadora de celdas', crit:'Aislada del agua, sin conectores flojos adentro. Con golpes secos, el peso no cambia. Si el sello o la junta están dañados, se sella.', fotos:[['deriv1','Foto del interior'],['deriv2','Foto de la caja cerrada o sellada']], sellado:true},
  {k:'bal', t:'4. Balanza estable y cero', crit:'Etiqueta Estable encendida, sin alerta CELDA DESCONECTADA, cero correcto. El peso reacciona a una carga y vuelve a Estable.', fotos:[['cab','Foto de la cabecera de pesaje']]},
  {k:'fant', t:'5. Sin peso fantasma del tubo', crit:'Con la tolva parada, abrir y cerrar el tubo: el neto no cambia.', fotos:[], video:'vfant'},
  {k:'sens', t:'6. Sensor inductivo', crit:'Posición y distancia correctas. La luz del sensor se enciende al acercarle metal. Modo automático activo, lógica según el mecanismo, retardo entre 0 y 6 s.', fotos:[['sens','Foto de CONFIGURAR SENSOR'],['sensled','Foto del sensor con la luz encendida']], sensor:true},
  {k:'desc', t:'7. Descarga automática de prueba', crit:'Al mover el tubo o el volquete, aparece la etiqueta Automática y la descarga cierra sola. Destino PREVENTIVO.', fotos:[['disp','Foto del DISPLAY con la etiqueta Automática']], prueba:true},
  {k:'cam', t:'8. Cámara', crit:'Con la tolva parada y el tubo abierto, la salida del tubo se ve bien en la pestaña CAMARA.', fotos:[['cam','Foto de la pestaña CAMARA']], soloCam:true},
  {k:'carga', t:'9. Carga de la tablet', crit:'Con el cargador del equipo enchufado, la tablet carga. Si no carga, se cambia el cargador y se marca en Repuestos.', fotos:[['carga','Foto de la tablet cargando']]},
];
const REPUESTOS = ['Cargador','Sensor','Cable de alimentación','Cable de cámara','Caja Corvus','Placa electrónica','Módulo Bluetooth','Tablet'];

const S = {
  sesion: leerJSON('sesion'), pant: 'lista', form: null, err: [], loginErr: '', cargando: false,
  red: navigator.onLine, mios: leerJSON('mios') || [], pendientes: 0, pendKb: 0, colaError: '',
  sop: {lista: [], sel: null, error: '', cargando: false, vistos: {}},
};

/* ---------- Utilidades ---------- */
function leerJSON(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } }
function guardarJSON(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ahora = () => new Date().toISOString();
const fechaCorta = iso => { if(!iso) return '—'; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); };
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
async function api(accion, datos){
  if(!CFG.API_URL || CFG.API_URL.indexOf('http') !== 0) throw new Error('Falta configurar la URL del servidor.');
  const r = await fetch(CFG.API_URL, {method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify(Object.assign({accion, token: S.sesion && S.sesion.token}, datos || {}))});
  const j = await r.json();
  if(!j.ok){ const e = new Error(j.error || 'Error del servidor.'); e.servidor = true; e.sesionVencida = j.sesionVencida; throw e; }
  return j;
}

/* ---------- Cola ---------- */
let procesando = false;
async function contarCola(){
  const xs = await colaTodos();
  S.pendientes = xs.length; S.pendKb = xs.reduce((a, x) => a + (x.kb || 1), 0);
  const sb = $('#syncbar'); if(sb) sb.outerHTML = syncbarHTML();
}
async function procesarCola(){
  if(procesando || !S.sesion || S.sesion.rol !== 'TECNICO') return;
  procesando = true;
  try{
    for(const item of await colaTodos()){
      try{
        const r = item.tipo === 'checklist' ? await api('checklist', {checklist: item.payload}) : await api('archivo', {archivo: item.payload});
        await colaBorrar(item.k);
        actualizarMio(item.id, m => {
          if(item.tipo === 'checklist'){ m.estado = r.estado || 'RECIBIDO'; m.bthValido = r.bthValido; }
          else { m.enviados = (m.enviados || 0) + 1; if(r.estado) m.estado = r.estado; }
        });
        S.red = true; S.colaError = '';
      }catch(e){
        if(e.sesionVencida){ S.colaError = 'La sesión venció: ingresá de nuevo para terminar de enviar.'; cerrarSesion(false); break; }
        if(!e.servidor){ S.red = false; break; }        // sin conexión: se reintenta después
        item.intentos = (item.intentos || 0) + 1; item.error = e.message; await colaActualizar(item);
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

/* ---------- Render general ---------- */
function render(){
  const app = $('#app');
  app.classList.toggle('ancho', !!(S.sesion && S.sesion.rol === 'SOPORTE'));
  if(!S.sesion) app.innerHTML = loginHTML();
  else if(S.sesion.rol === 'SOPORTE') app.innerHTML = soporteHTML();
  else if(S.pant === 'form') app.innerHTML = appbar('Nuevo preventivo', true) + progresoHTML() + '<div class="main">' + formHTML() + '</div>' + syncbarHTML();
  else app.innerHTML = appbar('Mis preventivos') + '<div class="main">' + listaHTML() + '</div>' + syncbarHTML();
  bind();
  if(S.pant === 'form' && S.form && S.form.bthInfo) iniciarFirma();
}
function appbar(titulo, volver){
  const red = S.red ? '<span class="net">con datos</span>' : '<span class="net off">sin señal</span>';
  const b = volver ? '<button class="iconbtn" data-act="volver" aria-label="Volver"><svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg></button>' : '';
  return `<div class="appbar">${b}<div class="titles"><div class="app-name">PREVENTIVO AGDP${S.sesion ? ' · ' + esc(S.sesion.usuario) : ''}</div><div class="view-name">${titulo}</div></div>${red}</div>`;
}
function syncbarHTML(){
  if(!S.pendientes) return `<div class="syncbar" id="syncbar"><span>Todo enviado</span><span>${S.colaError ? esc(S.colaError) : ''}</span></div>`;
  return `<div class="syncbar" id="syncbar"><span><b>${S.pendientes}</b> envíos pendientes · ${(S.pendKb/1024).toFixed(1)} MB</span><span>${S.colaError ? esc(S.colaError) : S.red ? 'enviando…' : 'esperando señal'}</span></div>`;
}
const tag = e => `<span class="tag ${{'EN EL CELULAR':'warn',RECIBIDO:'info',COMPLETO:'info',VALIDADO:'ok',OBSERVADO:'bad'}[e] || ''}">${esc(e)}</span>`;

/* ---------- Ingreso ---------- */
function loginHTML(){
  return appbar('Ingresar') + `<div class="login">
    <div class="logo">Preventivo AGDP</div><p class="hint">Usuario y clave que te dio Corvus.</p>
    <div class="field"><label for="lgUser">Usuario</label><input type="text" id="lgUser" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
    <div class="field"><label for="lgPin">Clave</label><input type="password" id="lgPin" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
    ${S.loginErr ? `<div class="errors" style="margin:8px 0">${esc(S.loginErr)}</div>` : ''}
    ${S.colaError ? `<div class="errors" style="margin:8px 0">${esc(S.colaError)}</div>` : ''}
    <button class="btn-main" style="margin:14px 0 0;width:100%" data-act="login" ${S.cargando ? 'disabled' : ''}>${S.cargando ? 'Ingresando…' : 'Ingresar'}</button>
    <p class="hint">El primer ingreso necesita señal. Después la sesión dura 30 días y la web abre sin señal.</p></div>`;
}

/* ---------- Técnico: lista ---------- */
function listaHTML(){
  let h = `<div class="group"><span>Cargados</span><span>${S.mios.length}</span></div>`;
  if(!S.mios.length) h += '<p class="hint" style="padding:12px 14px">Todavía no cargaste ninguno.</p>';
  S.mios.slice().reverse().forEach(m => {
    const pct = m.esperados ? Math.round(100 * Math.min(m.enviados || 0, m.esperados) / m.esperados) : 0;
    h += `<div class="row"><div class="avatar">${esc(m.bth)}</div><div class="txt"><div class="t1">B-T-H-${esc(m.bth)}</div>
      <div class="t2">${fechaCorta(m.inicio)} · ${m.enviados || 0} de ${m.esperados} archivos enviados</div><div class="bar"><i style="width:${pct}%"></i></div>
      ${tag(m.estado)}${m.bthValido === 'NO' ? ' <span class="tag bad">BTH no encontrado</span>' : ''}${m.motivo ? `<div class="t2" style="color:var(--bad)">${esc(m.motivo)}</div>` : ''}</div></div>`;
  });
  return h + `<button class="btn-main" data-act="nuevo">+ Nuevo preventivo</button><button class="textbtn" data-act="salir">Cerrar sesión</button>`;
}

/* ---------- Técnico: formulario ---------- */
function nuevoForm(){
  S.form = {id: nuevoId(), r:{}, cap:{}, repuestos:[], inicio: ahora(), gps: ''};
  S.err = []; S.pant = 'form'; tomarGps(); guardarBorrador();
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
function guardarBorrador(){ clearTimeout(borradorT); borradorT = setTimeout(() => { if(S.form) kvGuardar('borrador', S.form); }, 300); }

function tieneCam(){ const b = S.form.bthInfo; return b === 'offline' ? true : !!(b && b.cam); }
function formHTML(){
  const f = S.form;
  let h = `<div class="meta">Inicio ${fechaCorta(f.inicio)} · GPS <span id="metaGps">${esc(f.gps || 'buscando…')}</span><br>Hora y GPS los toma el celular.</div>`;
  h += `<div class="sec"><h4>Equipo</h4><div class="field"><label for="bth">Número de BTH: tablet → CONFIGURACION → INFO, Cód. Balanza <span class="req">*</span></label>
    <div class="bthrow"><span>B-T-H-</span><input type="tel" id="bth" inputmode="numeric" maxlength="4" data-f="bth" value="${esc(f.bth || '')}"></div></div>
    <button class="textbtn" style="padding:0" data-act="buscarbth">Buscar equipo</button>`;
  if(f.bthInfo === null) h += '<div class="ro bad">Ese BTH no existe en el padrón. Revisá la pantalla INFO.</div>';
  else if(f.bthInfo === 'offline') h += '<div class="ro">Sin señal: el BTH se controla al enviar. Se muestra también la cámara; marcá No aplica si no tiene.</div>';
  else if(f.bthInfo) h += `<div class="ro">Tipo de tolva: ${esc(f.bthInfo.tolva || 'sin dato')} · Cámara: ${f.bthInfo.cam ? 'sí' : 'no'}</div>`;
  h += '</div>';
  if(!f.bthInfo) return h + '<p class="hint" style="padding:0 14px">Cargá el BTH y tocá Buscar equipo para ver el checklist.</p>';

  ITEMS.forEach(it => {
    if(it.soloCam && !tieneCam()) return;
    const r = f.r[it.k];
    h += `<div class="sec"><h4>${it.t}</h4><p class="crit">${it.crit}</p>
      <div class="pills" data-item="${it.k}">${['OK','FALLA','NA'].map(v => `<button data-v="${v}" aria-pressed="${r === v}">${v === 'NA' ? 'No aplica' : v === 'FALLA' ? 'Falla' : 'OK'}</button>`).join('')}</div>`;
    if(it.sellado) h += `<div class="field"><label>¿Se selló la caja?</label><select data-f="sellado"><option value="">—</option>${['Sí','No hizo falta'].map(o => `<option ${f.sellado === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    if(it.sensor){
      const tolva = f.bthInfo === 'offline' ? '' : f.bthInfo.tolva;
      const esperada = tolva === 'SOJERA' ? 'NC' : tolva === 'MANICERA' ? 'NA' : '';
      h += `<div class="field"><label>Lógica del sensor <span class="req">*</span></label><select data-f="logica"><option value="">—</option>${['NC','NA'].map(o => `<option ${f.logica === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        ${f.logica && esperada && f.logica !== esperada ? `<div class="hint warn">El padrón dice ${esc(tolva)}: lo habitual es ${esperada}. Confirmá el mecanismo de descarga.</div>` : ''}</div>
        <div class="field"><label>Retardo (s) <span class="req">*</span></label><input type="number" min="0" max="6" inputmode="numeric" data-f="retardo" value="${esc(f.retardo ?? '')}"></div>`;
    }
    if(it.prueba) h += `<div class="field"><label>Hora de la descarga de prueba <span class="req">*</span></label><input type="text" inputmode="numeric" placeholder="hh:mm" data-f="hora" value="${esc(f.hora || '')}"><div class="hint">Soporte la busca en AGDP Web con esta hora y el BTH.</div></div>`;
    if(r !== 'NA'){
      it.fotos.forEach(([k, lbl]) => {
        const c = f.cap[k];
        h += `<div class="field"><button class="cap ${c ? 'done' : ''}" data-foto="${k}" data-item="${it.k}">${c ? `<img src="data:${c.mime};base64,${c.b64}" alt="">` : '<span class="thumb">cámara</span>'}
          <span><span>${lbl}${r ? ' <span class="req">*</span>' : ''}</span><br><span class="ps">${c ? fechaCorta(c.hora) + ' · ' + c.kb + ' KB · tocar para repetir' : 'Abre la cámara trasera'}</span></span></button></div>`;
      });
      if(it.video){
        const c = f.cap[it.video];
        h += `<div class="field"><button class="cap ${c ? 'done' : ''}" data-video="${it.video}" data-item="${it.k}"><span class="thumb">video</span>
          <span><span>Video de hasta 15 s${r ? ' <span class="req">*</span>' : ''}</span><br><span class="ps">${c ? fechaCorta(c.hora) + ' · ' + (c.kb / 1024).toFixed(1) + ' MB · tocar para repetir' : 'Graba en baja resolución, sin audio'}</span></span></button>
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

function requisitos(){
  const f = S.form, req = [], add = (ok, txt) => req.push({ok: !!ok, txt});
  add(f.bthInfo, 'Equipo: falta un BTH válido.');
  if(!f.bthInfo) return req;
  ITEMS.forEach(it => {
    if(it.soloCam && !tieneCam()) return;
    const r = f.r[it.k];
    add(r, `${it.t}: falta el resultado.`);
    if(r === 'NA') return;
    it.fotos.forEach(([k, lbl]) => add(f.cap[k], `${it.t}: falta ${lbl.toLowerCase()}.`));
    if(it.video) add(f.cap[it.video], `${it.t}: falta el video.`);
    if(it.sensor){
      add(f.logica, '6. Sensor: falta la lógica.');
      const rt = Number(f.retardo);
      add(!(f.retardo === undefined || f.retardo === '' || isNaN(rt) || rt < 0 || rt > 6), '6. Sensor: el retardo va de 0 a 6 s.');
    }
    if(it.prueba) add(/^\d{1,2}:\d{2}$/.test(f.hora || ''), '7. Descarga: falta la hora de la prueba (hh:mm).');
  });
  if(Object.values(f.r).includes('FALLA')) add((f.obs || '').trim(), 'Hay una falla: describila en Observaciones.');
  if(f.r.carga === 'FALLA') add(f.repuestos.length, '9. Carga: marcá en Repuestos lo que se cambió.');
  add((f.recibe || '').trim(), 'Conformidad: falta el nombre de quien recibe.');
  add(f.firma, 'Conformidad: falta la firma.');
  return req;
}
const faltantes = () => requisitos().filter(r => !r.ok).map(r => r.txt);
function progresoHTML(){
  if(!S.form.bthInfo) return '<div class="prog" id="prog"><div class="prog-top"><span>Cargá el equipo para empezar</span><b>0%</b></div><div class="bar big"><i style="width:0"></i></div></div>';
  const req = requisitos(), ok = req.filter(r => r.ok).length, pct = Math.round(100 * ok / req.length);
  return `<div class="prog" id="prog"><div class="prog-top"><span>${pct === 100 ? 'Checklist completo' : 'Progreso del checklist'}</span><b>${ok} de ${req.length}</b></div><div class="bar big"><i style="width:${pct}%;${pct < 100 ? 'background:var(--accent)' : ''}"></i></div></div>`;
}
function botonHTML(){
  const n = faltantes().length;
  if(!n) return `<button class="btn-main" data-act="guardar">Guardar ${S.red ? 'y enviar' : 'en el celular'}</button>`;
  return `<button class="btn-main" disabled>${n === 1 ? 'Falta 1 dato' : `Faltan ${n} datos`} para guardar</button><button class="textbtn" style="display:block;margin:0 auto 16px" data-act="verfalta">Ver qué falta</button>`;
}
function refrescarProgreso(){
  const p = $('#prog'); if(p) p.outerHTML = progresoHTML();
  const z = $('#zonaGuardar'); if(z){ z.innerHTML = botonHTML(); z.querySelectorAll('[data-act]').forEach(b => b.onclick = ev => { ev.preventDefault(); accion(b.dataset.act); }); }
  guardarBorrador();
}

/* ---------- Captura de fotos ---------- */
function elegirArchivo(accept, capture){
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; if(capture) i.setAttribute('capture', capture);
    i.onchange = () => res(i.files[0] || null); i.click();
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
  const b64 = await comprimirFoto(file);
  S.form.cap[clave] = {tipo:'foto', mime:'image/jpeg', b64, kb: kbDe(b64), hora: ahora(), item};
  render(); guardarBorrador();
}

/* ---------- Video ---------- */
const blobAB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function grabarVideo(clave, item){
  const mime = window.MediaRecorder && ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
  let stream = null;
  if(mime && navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
    try{ stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment', width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:20}}, audio:false}); }
    catch(e){ stream = null; }
  }
  if(!stream){ // respaldo: la cámara del sistema
    const file = await elegirArchivo('video/*', 'environment');
    if(!file) return;
    if(file.size > 25 * 1024 * 1024){ alert('El video pesa ' + (file.size / 1048576).toFixed(0) + ' MB. Grabá uno más corto (10 a 15 s).'); return; }
    const b64 = await blobAB64(file);
    S.form.cap[clave] = {tipo:'video', mime: file.type || 'video/mp4', b64, kb: kbDe(b64), hora: ahora(), item};
    render(); guardarBorrador(); return;
  }
  const ov = document.createElement('div'); ov.className = 'rec';
  ov.innerHTML = '<video autoplay playsinline muted></video><div class="ctrl"><span id="recT">Listo para grabar</span><button id="recBtn" style="background:#c0392b;color:#fff">Grabar</button><button id="recCancel">Cancelar</button></div>';
  document.body.appendChild(ov);
  ov.querySelector('video').srcObject = stream;
  const cerrar = () => { stream.getTracks().forEach(t => t.stop()); ov.remove(); };
  ov.querySelector('#recCancel').onclick = cerrar;
  let rec = null, partes = [], t0 = 0, timer = null;
  ov.querySelector('#recBtn').onclick = () => {
    const btn = ov.querySelector('#recBtn');
    if(rec){ rec.stop(); return; }
    rec = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 600000});
    rec.ondataavailable = e => { if(e.data.size) partes.push(e.data); };
    rec.onstop = async () => {
      clearInterval(timer);
      const blob = new Blob(partes, {type: mime.split(';')[0]});
      const b64 = await blobAB64(blob);
      S.form.cap[clave] = {tipo:'video', mime: mime.split(';')[0], b64, kb: kbDe(b64), hora: ahora(), item};
      cerrar(); render(); guardarBorrador();
    };
    rec.start(1000); t0 = Date.now(); btn.textContent = 'Detener';
    timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); ov.querySelector('#recT').textContent = 'Grabando ' + s + ' s de 15'; if(s >= 15) rec.stop(); }, 250);
  };
}

/* ---------- Firma ---------- */
function iniciarFirma(){
  const c = $('#sig'); if(!c) return;
  const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1f2328';
  if(S.form.firma){ const im = new Image(); im.onload = () => ctx.drawImage(im, 0, 0, r.width, r.height); im.src = 'data:image/png;base64,' + S.form.firma; }
  let abajo = false;
  const pos = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  c.onpointerdown = e => { abajo = true; c.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  c.onpointermove = e => { if(!abajo) return; ctx.lineTo(...pos(e)); ctx.stroke(); };
  c.onpointerup = () => { if(!abajo) return; abajo = false; S.form.firma = c.toDataURL('image/png').split(',')[1]; $('#sigHint').textContent = 'Firma cargada'; refrescarProgreso(); };
}

/* ---------- Guardar ---------- */
async function guardar(){
  S.err = faltantes(); if(S.err.length){ render(); return; }
  const f = S.form;
  const archivos = Object.entries(f.cap).map(([clave, c]) => ({clave, c}));
  archivos.push({clave:'firma', c:{tipo:'firma', mime:'image/png', b64:f.firma, kb:kbDe(f.firma), hora:ahora(), item:'conformidad'}});
  const checklist = {id:f.id, bth:f.bth, inicio:f.inicio, gps:f.gps, r:Object.fromEntries(ITEMS.map(it => [it.k, f.r[it.k] || 'NA'])),
    sellado:f.sellado || '', logica:f.logica || '', retardo:f.retardo ?? '', hora:f.hora || '', repuestos:f.repuestos, obs:f.obs || '', recibe:f.recibe, esperados:archivos.length};
  await colaAgregar({tipo:'checklist', id:f.id, payload:checklist, kb:2});
  for(const a of archivos){
    await colaAgregar({tipo:'archivo', id:f.id, kb:a.c.kb, payload:{id:f.id, clave:a.clave, item:a.c.item, tipo:a.c.tipo, mime:a.c.mime, capturado:a.c.hora, datos:a.c.b64}});
  }
  S.mios.push({id:f.id, bth:f.bth, inicio:f.inicio, estado:'EN EL CELULAR', enviados:0, esperados:archivos.length});
  guardarJSON('mios', S.mios);
  await kvBorrar('borrador');
  S.form = null; S.pant = 'lista'; render(); await contarCola(); procesarCola();
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
  let h = `<div class="appbar"><div class="titles"><div class="app-name">PREVENTIVO AGDP · ${esc(S.sesion.usuario)} · Soporte</div><div class="view-name">Validación de preventivos</div></div>
    <button class="iconbtn" data-act="recargar">Actualizar</button><button class="iconbtn" data-act="salir">Salir</button></div>`;
  if(S.sop.error) h += `<div class="errors">${esc(S.sop.error)}</div>`;
  if(S.sop.cargando) h += '<p class="hint" style="padding:10px 14px">Cargando…</p>';
  h += '<div class="valgrid"><div class="list">';
  ['RECIBIDO','COMPLETO','OBSERVADO','VALIDADO'].forEach(est => {
    const g = L.filter(c => c.ESTADO === est); if(!g.length) return;
    h += `<div class="group"><span>${est}</span><span>${g.length}</span></div>`;
    g.forEach(c => { h += `<button class="row" data-sel="${esc(c.ID)}" style="${sel && sel.ID === c.ID ? 'background:var(--accent-soft)' : ''}"><div class="avatar">${esc(c.BTH)}</div><div class="txt"><div class="t1">B-T-H-${esc(c.BTH)}${c.BTH_VALIDO === 'NO' ? ' <span class="tag bad">no existe</span>' : ''}</div><div class="t2">${esc(c.USUARIO_AGDP || '—')} · ${esc(c.TECNICO)}</div><div class="t2">Prueba ${esc(c.HORA_PRUEBA || '—')} · ${c.ARCHIVOS_RECIBIDOS} de ${c.ARCHIVOS_ESPERADOS} archivos</div></div></button>`; });
  });
  if(!L.length && !S.sop.cargando) h += '<p class="hint" style="padding:12px 14px">No hay checklists.</p>';
  h += '</div><div class="det">';
  if(sel){
    h += `<h3 style="margin-top:0">B-T-H-${esc(sel.BTH)} ${tag(sel.ESTADO)}</h3><p class="hint">${esc(sel.USUARIO_AGDP || 'BTH no encontrado en TABLET')} · ${esc(sel.TIPO_TOLVA || '—')} · técnico ${esc(sel.TECNICO)} · inicio ${fechaCorta(sel.INICIO)} · GPS ${esc(sel.GPS)} · ${esc(sel.ID)}</p>`;
    const map = {ident:'R_IDENTIDAD',conec:'R_CONECTORES',deriv:'R_DERIVADORA',bal:'R_BALANZA',fant:'R_FANTASMA',sens:'R_SENSOR',desc:'R_DESCARGA',cam:'R_CAMARA',carga:'R_CARGA'};
    ITEMS.forEach(it => { const v = sel[map[it.k]] || 'NA'; h += `<div class="evrow"><span>${it.t}</span><span>${v === 'OK' ? '<span class="tag ok">OK</span>' : v === 'FALLA' ? '<span class="tag bad">Falla</span>' : '<span class="tag">No aplica</span>'}</span></div>`; });
    h += `<div class="evrow"><span>Sensor</span><span>Lógica ${esc(sel.LOGICA_SENSOR || '—')} · retardo ${esc(sel.RETARDO)} s</span></div>
      <div class="evrow"><span>Caja derivadora sellada</span><span>${esc(sel.SELLADO || '—')}</span></div>
      <div class="evrow"><span>Repuestos</span><span>${esc(sel.REPUESTOS || 'ninguno')}</span></div>
      <div class="evrow"><span>Conformidad</span><span>${esc(sel.RECIBE)}</span></div>`;
    if(sel.OBS) h += `<p class="hint">Observaciones: ${esc(sel.OBS)}</p>`;
    h += '<div class="galeria">' + sel.archivos.map(a => {
      const v = S.sop.vistos[a.fileId];
      const cont = !v ? `<button data-ver="${esc(a.fileId)}">Ver ${esc(a.tipo)} (${Math.round(a.bytes / 1024)} KB)</button>` : v === 'cargando' ? '<button disabled>Cargando…</button>' :
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
    else {
      const completo = sel.ESTADO === 'COMPLETO';
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
  catch(e){ delete S.sop.vistos[fileId]; S.sop.error = e.message; }
  render();
}
async function resolver(resultado){
  const id = S.sop.sel, idDescarga = ($('#idDesc') || {}).value || '', motivo = ($('#motivo') || {}).value || '';
  try{ await api('validar', {id, resultado, idDescarga, motivo}); await cargarSoporte(); }
  catch(e){ S.sop.error = e.message; render(); }
}

/* ---------- Eventos ---------- */
function bind(){
  $$('[data-act]').forEach(b => b.onclick = ev => { ev.preventDefault(); accion(b.dataset.act); });
  const pin = $('#lgPin'); if(pin) pin.onkeydown = e => { if(e.key === 'Enter') ingresar(); };
  $$('[data-sel]').forEach(b => b.onclick = () => { S.sop.sel = b.dataset.sel; S.sop.error = ''; render(); });
  $$('[data-ver]').forEach(b => b.onclick = () => verArchivo(b.dataset.ver));
  $$('.pills[data-item]').forEach(p => p.querySelectorAll('button').forEach(b => b.onclick = () => { S.form.r[p.dataset.item] = b.dataset.v; render(); guardarBorrador(); }));
  $$('[data-foto]').forEach(b => b.onclick = () => tomarFoto(b.dataset.foto, b.dataset.item));
  $$('[data-video]').forEach(b => b.onclick = () => grabarVideo(b.dataset.video, b.dataset.item));
  $$('[data-rep]').forEach(i => i.onchange = () => {
    const s = new Set(S.form.repuestos); i.checked ? s.add(i.dataset.rep) : s.delete(i.dataset.rep);
    S.form.repuestos = REPUESTOS.filter(x => s.has(x)); refrescarProgreso();
  });
  $$('[data-f]').forEach(i => {
    const k = i.dataset.f;
    i.oninput = () => { S.form[k] = k === 'bth' ? i.value.replace(/\D/g, '') : i.value; if(k === 'bth'){ i.value = S.form.bth; S.form.bthInfo = undefined; } refrescarProgreso(); };
    if(i.tagName === 'SELECT') i.onchange = () => { S.form[k] = i.value; render(); guardarBorrador(); };
    if(k === 'bth') i.onchange = () => render();
  });
}
async function accion(a){
  if(a === 'login') return ingresar();
  if(a === 'salir'){ if(S.pendientes && !confirm('Hay envíos pendientes. Se envían cuando vuelvas a ingresar. ¿Cerrar sesión?')) return; return cerrarSesion(); }
  if(a === 'nuevo'){
    if(S.form && confirm('Tenés un checklist sin terminar (B-T-H-' + (S.form.bth || '?') + '). ¿Seguir con ese? Cancelar lo descarta.')){ S.pant = 'form'; return render(); }
    nuevoForm(); return render();
  }
  if(a === 'volver'){ if(!confirm('El checklist queda guardado como borrador en el celular. ¿Volver a la lista?')) return; S.pant = 'lista'; return render(); }
  if(a === 'buscarbth'){
    const b = (S.form.bth || '').trim();
    if(!/^\d{3,4}$/.test(b)){ S.form.bthInfo = null; return render(); }
    try{ const r = await api('bth', {bth:b}); S.form.bthInfo = r.existe ? {tolva:r.tolva, cam:r.cam} : null; S.red = true; }
    catch(e){ if(e.servidor){ alert(e.message); return; } S.form.bthInfo = 'offline'; S.red = false; }
    guardarBorrador(); return render();
  }
  if(a === 'verfalta'){ S.err = faltantes(); render(); const e = $('.errors'); if(e) e.scrollIntoView({block:'center'}); return; }
  if(a === 'borrarfirma'){ S.form.firma = null; return render(); }
  if(a === 'guardar') return guardar();
  if(a === 'recargar') return cargarSoporte();
  if(a === 'validar') return resolver('VALIDADO');
  if(a === 'observar') return resolver('OBSERVADO');
}

/* ---------- Arranque ---------- */
window.addEventListener('online', () => { S.red = true; procesarCola(); refrescarMios(); render(); });
window.addEventListener('offline', () => { S.red = false; render(); });
setInterval(() => { if(navigator.onLine) procesarCola(); }, 30000);
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => {
  const b = await kvLeer('borrador').catch(() => null);
  if(b && S.sesion && S.sesion.rol === 'TECNICO'){ S.form = b; S.pant = 'form'; }
  render(); await contarCola();
  if(S.sesion && S.sesion.rol === 'TECNICO'){ procesarCola(); refrescarMios(); }
  if(S.sesion && S.sesion.rol === 'SOPORTE') cargarSoporte();
})();
