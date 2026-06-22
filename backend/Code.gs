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

// ── Webhook de venda (Vaultly) ──
const VENDAS_SHEET = 'Vendas';      // idempotência: 1 venda = 1 chave
const PROD_SHEET   = 'Produtos';    // mapeamento produto -> tipo/link/template
const V = { TRANSACAO:1, PRODUTO:2, EMAIL:3, CHAVE:4, DATA:5, STATUS:6 };
const P = { PRODUTO:1, TIPO:2, LINK:3, TEMPLATE:4 };

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
    if (acao === 'desativar') return jsonOut_(desativar_(chave, aparelho));
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

/* Desvincular ESTE aparelho — self-service pelo app: libera 1 vaga da chave. */
function desativar_(chave, aparelho) {
  if (!chave || !aparelho) return logRet_(chave, aparelho, 'invalida');
  const found = findKeyRow_(chave);
  if (!found) return logRet_(chave, aparelho, 'invalida');

  const sh = found.sheet, r = found.row, v = found.values;
  let ids;
  try { ids = JSON.parse(v[C.IDS-1] || '[]'); } catch (e2) { ids = []; }

  const i = ids.indexOf(aparelho);
  if (i !== -1) ids.splice(i, 1);   // se não estava na lista, segue idempotente (ok)

  sh.getRange(r, C.APARELHOS).setValue(ids.length);
  sh.getRange(r, C.IDS).setValue(JSON.stringify(ids));
  sh.getRange(r, C.ULTIMA).setValue(new Date());
  log_(chave, aparelho, 'desativado');
  return { ok:true, vagas: (Number(v[C.MAX-1]) || 2) - ids.length };
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

/* ════════════════════ WEBHOOK DE VENDA (Vaultly — Modelo A) ════════════════════
 * Contrato (POST x-www-form-urlencoded, roteado por acao=venda):
 *   payload = <JSON exato>   sig = <HMAC-SHA256 hex do payload, com WEBHOOK_SECRET>
 * payload venda : {event:"sale", transacao_id, produto_id, email, nome, valor_cents, data}
 * payload refund: {event:"refund", transacao_id}
 * Resposta: {ok:true, codigo, link}  ou  {ok:false, erro:"esgotado|assinatura|..."}
 * A Vaultly templata e ENVIA o e-mail (Modelo A) — aqui NÃO enviamos e-mail.
 * Apps Script não expõe headers: por isso a assinatura vem no corpo (campo sig).
 */
function handleVenda_(e) {
  const params = (e && e.parameter) || {};
  const payloadStr = params.payload || (e.postData && e.postData.contents) || '';
  const sig = params.sig || '';
  if (!payloadStr) return { ok:false, erro:'payload' };
  if (!verifySig_(payloadStr, sig)) return { ok:false, erro:'assinatura' };

  let body;
  try { body = JSON.parse(payloadStr); } catch (err) { return { ok:false, erro:'json' }; }

  const event     = String(body.event || 'sale').toLowerCase();
  const transacao = String(body.transacao_id || '').trim();
  if (!transacao) return { ok:false, erro:'sem_transacao' };

  if (event === 'refund') return refundVenda_(transacao);

  // ── Venda ──
  const email     = String(body.email || '').trim().toLowerCase();
  const nome      = String(body.nome || '').trim();
  const produtoId = String(body.produto_id || '').trim();
  if (!email) return { ok:false, erro:'sem_email' };

  const prod = getProduto_(produtoId); // {tipo, link, template} (default: codigo + APP_LINK)

  // Idempotência: a Vaultly reenvia até 3x — nunca emitir 2 chaves p/ a mesma venda.
  const ja = findVenda_(transacao);
  if (ja && ['entregue','link'].indexOf(String(ja.status).toLowerCase()) !== -1) {
    return ja.chave ? { ok:true, codigo: ja.chave, link: prod.link } : { ok:true, link: prod.link };
  }

  if (prod.tipo === 'link') {
    if (ja) updateVenda_(transacao, '', 'link'); else recordVenda_(transacao, produtoId, email, '', 'link');
    return { ok:true, link: prod.link };
  }

  // tipo 'codigo' → consome uma chave da aba "Chaves"
  const chave = pegarChaveDisponivel_(email, nome, transacao);
  if (!chave) {
    if (!ja) recordVenda_(transacao, produtoId, email, '', 'sem_estoque');
    alertAdmin_('Lucro App: ESTOQUE DE CHAVES ESGOTADO',
      'A venda ' + transacao + ' (produto ' + (produtoId||'-') + ', ' + email + ') ficou SEM CHAVE.\n' +
      'Gere mais chaves no menu "Lucro App" → Gerar chaves. A Vaultly vai reenviar e a entrega completa sozinha.');
    return { ok:false, erro:'esgotado' };
  }
  if (ja) updateVenda_(transacao, chave, 'entregue'); else recordVenda_(transacao, produtoId, email, chave, 'entregue');
  return { ok:true, codigo: chave, link: prod.link };
}

/* Reembolso/chargeback → revoga a chave da venda (app trava na próxima revalidação). */
function refundVenda_(transacao) {
  const ja = findVenda_(transacao);
  if (!ja) return { ok:true };                 // nada a fazer (idempotente)
  if (ja.chave) revogarChave_(ja.chave);
  updateVenda_(transacao, ja.chave, 'reembolsada');
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
    .addSeparator()
    .addItem('Webhook: ver segredo (colar na Vaultly)', 'menuWebhookSecret')
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
  // Aba Vendas (idempotência do webhook de venda)
  let vendas = ss.getSheetByName(VENDAS_SHEET) || ss.insertSheet(VENDAS_SHEET);
  if (vendas.getLastRow() === 0) {
    vendas.appendRow(['transacao_id','produto','email','chave','data','status']);
    vendas.getRange('1:1').setFontWeight('bold'); vendas.setFrozenRows(1);
  }
  // Aba Produtos (mapeamento produto -> codigo|link)
  let prods = ss.getSheetByName(PROD_SHEET) || ss.insertSheet(PROD_SHEET);
  if (prods.getLastRow() === 0) {
    prods.appendRow(['produto_id','tipo','link','template']);
    prods.appendRow(['', 'codigo', APP_LINK, '']); // exemplo: preencha produto_id com o SLUG da Vaultly
    prods.getRange('1:1').setFontWeight('bold'); prods.setFrozenRows(1);
  }

  // Segredo do token (em Script Properties — fora da planilha e do código)
  secret_();
  webhookSecret_();   // segredo do webhook de venda (separado)
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

function pegarChaveDisponivel_(email, nome, transacao) {
  const sh = getSheet_(KEY_SHEET);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][C.STATUS-1]).toLowerCase() === 'disponivel') {
      const r = i+1;
      sh.getRange(r, C.STATUS).setValue('vendida');
      sh.getRange(r, C.EMAIL).setValue(email);
      if (nome) sh.getRange(r, C.NOME).setValue(nome);
      sh.getRange(r, C.DATA_VENDA).setValue(new Date());
      if (transacao) sh.getRange(r, C.OBS).setValue('venda:' + transacao);
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

/* ── Webhook de venda (Vaultly): assinatura, idempotência, produtos ── */

function webhookSecret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('WEBHOOK_SECRET');
  if (!s) { s = Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,''); p.setProperty('WEBHOOK_SECRET', s); }
  return s;
}

function hmacHex_(str) {
  const bytes = Utilities.computeHmacSha256Signature(str, webhookSecret_());
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// Compara a assinatura recebida (no corpo) com o HMAC esperado, em tempo ~constante.
function verifySig_(payloadStr, sig) {
  const got = String(sig || '').replace(/^sha256=/i, '').toLowerCase();
  const exp = hmacHex_(payloadStr);
  if (got.length !== exp.length) return false;
  let diff = 0;
  for (let i = 0; i < exp.length; i++) diff |= got.charCodeAt(i) ^ exp.charCodeAt(i);
  return diff === 0;
}

// Config do produto na aba "Produtos". Default seguro: codigo + APP_LINK.
function getProduto_(produtoId) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PROD_SHEET);
    if (sh && produtoId) {
      const vals = sh.getDataRange().getValues();
      for (let i = 1; i < vals.length; i++) {
        if (String(vals[i][P.PRODUTO-1]).trim() === produtoId) {
          return {
            tipo: String(vals[i][P.TIPO-1] || 'codigo').toLowerCase(),
            link: String(vals[i][P.LINK-1] || APP_LINK),
            template: String(vals[i][P.TEMPLATE-1] || '')
          };
        }
      }
    }
  } catch (e) {}
  return { tipo: 'codigo', link: APP_LINK, template: '' };
}

function findVenda_(transacao) {
  const sh = getSheet_(VENDAS_SHEET);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][V.TRANSACAO-1]).trim() === transacao) {
      return { row:i+1, chave:String(vals[i][V.CHAVE-1]||''), status:String(vals[i][V.STATUS-1]||'') };
    }
  }
  return null;
}

function recordVenda_(transacao, produto, email, chave, status) {
  getSheet_(VENDAS_SHEET).appendRow([transacao, produto, email, chave, new Date(), status]);
}

function updateVenda_(transacao, chave, status) {
  const v = findVenda_(transacao);
  if (!v) return;
  const sh = getSheet_(VENDAS_SHEET);
  if (chave !== undefined && chave !== null) sh.getRange(v.row, V.CHAVE).setValue(chave);
  sh.getRange(v.row, V.STATUS).setValue(status);
}

function revogarChave_(chave) {
  const found = findKeyRow_(normKey_(chave));
  if (found) found.sheet.getRange(found.row, C.STATUS).setValue('revogada');
}

function alertAdmin_(assunto, corpo) {
  try {
    const to = getConfig_('admin_email') || Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail({ to: to, subject: assunto, body: corpo });
  } catch (e) {}
}

function menuWebhookSecret() {
  SpreadsheetApp.getUi().alert('Segredo do webhook (cole na Vaultly, no campo do produto):\n\n' + webhookSecret_());
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
