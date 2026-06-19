/************************************************************************
 * LUCRO APP — Backend de Licenças (Google Apps Script + Planilha)
 * ---------------------------------------------------------------------
 * Contrato com o app (lucroapp.dnai.shop/app/):
 *   POST  (application/x-www-form-urlencoded)
 *     acao=ativar|revalidar  &  chave=<CHAVE>  &  aparelho=<ID>
 *   Resposta JSON:
 *     sucesso -> { "ok": true,  "token": "<hmac>" }
 *     falha   -> { "ok": false, "erro": "limite|invalida|revogada" }
 *
 * COMO USAR (resumo — passo a passo completo no INSTRUCOES.md):
 *   1) Planilha nova > Extensões > Apps Script > cole este arquivo.
 *   2) Rode a função setup() uma vez (autorize quando pedir).
 *   3) Implantar > Nova implantação > App da Web
 *        Executar como: Eu  |  Quem acessa: Qualquer pessoa
 *      Copie a URL (termina em /exec).
 *   4) Cole essa URL em LICENSE.endpoint no app/index.html.
 *   5) Menu "Lucro App" > Gerar chaves.
 ************************************************************************/

const KEY_SHEET   = 'Chaves';
const LOG_SHEET   = 'Ativacoes';
const CFG_SHEET   = 'Config';
const KEY_PREFIX  = 'LUCRO';
const KEY_ALPHABET= 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O,0,I,1 (evita confusão)
const APP_LINK    = 'https://lucroapp.dnai.shop/app/';

// Colunas da aba "Chaves" (1-based)
const C = {
  CHAVE:1, STATUS:2, EMAIL:3, NOME:4, DATA_VENDA:5,
  APARELHOS:6, MAX:7, IDS:8, ATIVADA_EM:9, ULTIMA:10, OBS:11
};

/* ════════════════════ ENDPOINTS HTTP ════════════════════ */

function doGet(e) {
  return jsonOut_({ ok: true, service: 'lucroapp-licencas' });
}

function doPost(e) {
  const p = (e && e.parameter) || {};
  const acao     = (p.acao     || '').toLowerCase();
  const chave    = normKey_(p.chave || '');
  const aparelho = (p.aparelho || '').trim();

  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (err) { return jsonOut_({ ok:false, erro:'ocupado' }); }
  try {
    if (acao === 'ativar')    return jsonOut_(ativar_(chave, aparelho));
    if (acao === 'revalidar') return jsonOut_(revalidar_(chave, aparelho));
    if (acao === 'venda')     return jsonOut_(handleVenda_(e));   // opcional (webhook)
    return jsonOut_({ ok:false, erro:'acao_invalida' });
  } finally {
    lock.releaseLock();
  }
}

/* ════════════════════ REGRAS DE LICENÇA ════════════════════ */

function ativar_(chave, aparelho) {
  if (!chave || !aparelho) return logRet_(chave, aparelho, 'invalida');
  const found = findKeyRow_(chave);
  if (!found) return logRet_(chave, aparelho, 'invalida');

  const sh = found.sheet, r = found.row, v = found.values;
  if (String(v[C.STATUS-1]).toLowerCase() === 'revogada') return logRet_(chave, aparelho, 'revogada');

  let ids;
  try { ids = JSON.parse(v[C.IDS-1] || '[]'); } catch (e2) { ids = []; }
  const max = Number(v[C.MAX-1]) || 2;
  const agora = new Date();

  // Aparelho já registrado -> apenas renova
  if (ids.indexOf(aparelho) !== -1) {
    sh.getRange(r, C.ULTIMA).setValue(agora);
    log_(chave, aparelho, 'ok');
    return { ok:true, token: token_(chave, aparelho) };
  }
  // Aparelho novo -> precisa de vaga
  if (ids.length >= max) return logRet_(chave, aparelho, 'limite');

  ids.push(aparelho);
  sh.getRange(r, C.STATUS).setValue('ativada');
  sh.getRange(r, C.APARELHOS).setValue(ids.length);
  sh.getRange(r, C.IDS).setValue(JSON.stringify(ids));
  if (!v[C.ATIVADA_EM-1]) sh.getRange(r, C.ATIVADA_EM).setValue(agora);
  sh.getRange(r, C.ULTIMA).setValue(agora);
  log_(chave, aparelho, 'ok');
  return { ok:true, token: token_(chave, aparelho) };
}

function revalidar_(chave, aparelho) {
  const found = findKeyRow_(chave);
  if (!found) return { ok:false, erro:'invalida' };
  const status = String(found.values[C.STATUS-1]).toLowerCase();
  if (status === 'revogada') return { ok:false, erro:'revogada' };
  // chave válida: renova carimbo e libera (não tranca offline no cliente)
  found.sheet.getRange(found.row, C.ULTIMA).setValue(new Date());
  return { ok:true, token: token_(chave, aparelho) };
}

/* ════════════════════ WEBHOOK DE VENDA (opcional) ════════════════════
 * Liga a venda à entrega automática da chave por e-mail.
 * O formato do corpo varia por plataforma (Vaultly/Kiwify/Yampi) — ADAPTE
 * a extração do e-mail conforme o payload real quando for ligar o webhook.
 */
function handleVenda_(e) {
  let email = '';
  try {
    if (e.parameter && e.parameter.email) email = e.parameter.email;
    else if (e.postData && e.postData.contents) {
      const b = JSON.parse(e.postData.contents);
      email = b.email || (b.customer && b.customer.email) || b.buyer_email || '';
    }
  } catch (err) {}
  email = (email || '').trim().toLowerCase();
  if (!email) return { ok:false, erro:'sem_email' };

  const chave = pegarChaveDisponivel_(email);
  if (!chave) return { ok:false, erro:'sem_estoque' };  // gere mais chaves no menu

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Sua chave do Lucro App 🚗',
      htmlBody:
        'Olá! Obrigado pela compra. 🎉<br><br>' +
        'Sua chave de licença é:<br>' +
        '<b style="font-size:20px;letter-spacing:2px">' + chave + '</b><br><br>' +
        'Acesse e ative em: <a href="' + APP_LINK + '">' + APP_LINK + '</a><br>' +
        'A chave funciona em até 2 aparelhos (ex.: celular + PC).<br><br>' +
        'Bons lucros! 🚀'
    });
  } catch (err) { /* falha de e-mail não invalida a venda */ }
  return { ok:true };
}

/* ════════════════════ MENU DE GESTÃO (na planilha) ════════════════════ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Lucro App')
    .addItem('Gerar chaves…', 'menuGerarChaves')
    .addSeparator()
    .addItem('Revogar chave (linha selecionada)', 'menuRevogar')
    .addItem('Resetar aparelhos (linha selecionada)', 'menuResetar')
    .addToUi();
}

function menuGerarChaves() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Gerar chaves', 'Quantas chaves criar?', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const n = parseInt(resp.getResponseText(), 10);
  if (!n || n < 1 || n > 1000) { ui.alert('Informe um número entre 1 e 1000.'); return; }

  const sh = getSheet_(KEY_SHEET);
  const max = Number(getConfig_('max_aparelhos')) || 2;
  const existentes = chavesExistentes_(sh);
  const novas = [];
  while (novas.length < n) {
    const k = gerarChave_();
    if (!existentes.has(k)) { existentes.add(k); novas.push([k,'disponivel','','','',0,max,'[]','','','']); }
  }
  sh.getRange(sh.getLastRow()+1, 1, novas.length, 11).setValues(novas);
  ui.alert(novas.length + ' chave(s) gerada(s). Veja na aba "' + KEY_SHEET + '".');
}

function menuRevogar() {
  const sh = SpreadsheetApp.getActiveSheet();
  const r = sh.getActiveRange().getRow();
  if (sh.getName() !== KEY_SHEET || r < 2) { SpreadsheetApp.getUi().alert('Selecione a linha da chave na aba "' + KEY_SHEET + '".'); return; }
  sh.getRange(r, C.STATUS).setValue('revogada');
  SpreadsheetApp.getUi().alert('Chave revogada: ' + sh.getRange(r, C.CHAVE).getValue());
}

function menuResetar() {
  const sh = SpreadsheetApp.getActiveSheet();
  const r = sh.getActiveRange().getRow();
  if (sh.getName() !== KEY_SHEET || r < 2) { SpreadsheetApp.getUi().alert('Selecione a linha da chave na aba "' + KEY_SHEET + '".'); return; }
  sh.getRange(r, C.APARELHOS).setValue(0);
  sh.getRange(r, C.IDS).setValue('[]');
  const email = sh.getRange(r, C.EMAIL).getValue();
  sh.getRange(r, C.STATUS).setValue(email ? 'vendida' : 'disponivel');
  SpreadsheetApp.getUi().alert('Aparelhos resetados para: ' + sh.getRange(r, C.CHAVE).getValue());
}

/* ════════════════════ SETUP (rodar 1x) ════════════════════ */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Aba Chaves
  let chaves = ss.getSheetByName(KEY_SHEET) || ss.insertSheet(KEY_SHEET);
  if (chaves.getLastRow() === 0) {
    chaves.appendRow(['chave','status','email','nome','data_venda','aparelhos','max_aparelhos','ids_aparelhos','ativada_em','ultima_ativacao','obs']);
    chaves.getRange('1:1').setFontWeight('bold');
    chaves.setFrozenRows(1);
  }
  // Aba Ativacoes (log)
  let log = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  if (log.getLastRow() === 0) {
    log.appendRow(['data','chave','id_aparelho','resultado']);
    log.getRange('1:1').setFontWeight('bold');
    log.setFrozenRows(1);
  }
  // Aba Config
  let cfg = ss.getSheetByName(CFG_SHEET) || ss.insertSheet(CFG_SHEET);
  if (cfg.getLastRow() === 0) {
    cfg.appendRow(['chave','valor']);
    cfg.appendRow(['max_aparelhos', 2]);
    cfg.getRange('1:1').setFontWeight('bold');
  }
  // Segredo do token (em Script Properties — fora da planilha e do código)
  secret_();
  // Remove a planilha-padrão vazia, se existir
  const def = ss.getSheetByName('Página1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) { try { ss.deleteSheet(def); } catch (e) {} }

  SpreadsheetApp.getUi().alert('Setup concluído! Agora: Implantar > Nova implantação > App da Web.');
}

/* ════════════════════ HELPERS ════════════════════ */

function getSheet_(nome) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
  if (!sh) throw new Error('Aba "' + nome + '" não encontrada. Rode setup() primeiro.');
  return sh;
}

function getConfig_(chave) {
  const sh = getSheet_(CFG_SHEET);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === chave) return vals[i][1];
  return null;
}

function findKeyRow_(chave) {
  const sh = getSheet_(KEY_SHEET);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (normKey_(vals[i][C.CHAVE-1]) === chave) return { sheet: sh, row: i+1, values: vals[i] };
  }
  return null;
}

function chavesExistentes_(sh) {
  const set = new Set();
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) set.add(normKey_(vals[i][0]));
  return set;
}

function pegarChaveDisponivel_(email) {
  const sh = getSheet_(KEY_SHEET);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][C.STATUS-1]).toLowerCase() === 'disponivel') {
      const r = i+1;
      sh.getRange(r, C.STATUS).setValue('vendida');
      sh.getRange(r, C.EMAIL).setValue(email);
      sh.getRange(r, C.DATA_VENDA).setValue(new Date());
      return String(vals[i][C.CHAVE-1]);
    }
  }
  return null;
}

function gerarChave_() {
  function bloco(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += KEY_ALPHABET.charAt(Math.floor(Math.random()*KEY_ALPHABET.length));
    return s;
  }
  return KEY_PREFIX + '-' + bloco(4) + '-' + bloco(4);
}

function normKey_(s) { return String(s || '').trim().toUpperCase(); }

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s;
}

function token_(chave, aparelho) {
  const raw = Utilities.computeHmacSha256Signature(chave + '|' + aparelho, secret_());
  return Utilities.base64EncodeWebSafe(raw);
}

function log_(chave, aparelho, resultado) {
  try { getSheet_(LOG_SHEET).appendRow([new Date(), chave, aparelho, resultado]); } catch (e) {}
}

function logRet_(chave, aparelho, erro) {
  log_(chave, aparelho, erro);
  return { ok:false, erro: erro };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
