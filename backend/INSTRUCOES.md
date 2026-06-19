# Backend de Licenças — Lucro App (Google Apps Script)

Guarda as chaves, conta ativações por aparelho (limite **2**) e valida o app.
A planilha é o seu **painel**: você vê e gerencia tudo ali.

---

## 1. Criar a planilha + colar o código

1. Acesse <https://sheets.new> (cria uma planilha nova). Dê o nome **Lucro App — Licenças**.
2. Menu **Extensões → Apps Script**.
3. Apague o conteúdo de `Código.gs` e **cole todo o `Code.gs`** (deste repositório).
4. Clique em 💾 **Salvar**.

## 2. Rodar o setup (uma vez)

1. Na barra de funções (topo), selecione **`setup`** e clique **▶ Executar**.
2. Vai pedir autorização → **Revisar permissões** → escolha sua conta Google →
   "O app não foi verificado" → **Avançado → Acessar (não seguro)** → **Permitir**.
   (É seu próprio script; o "não verificado" é normal.)
3. Pronto: ele cria as abas **Chaves**, **Ativacoes** e **Config**.

## 3. Publicar como App da Web

1. **Implantar → Nova implantação**.
2. Engrenagem ⚙ → tipo **App da Web**.
3. Configure:
   - **Executar como:** `Eu`
   - **Quem pode acessar:** `Qualquer pessoa`  ← importante (o app chama sem login)
4. **Implantar** → copie a **URL do app da Web** (termina em `/exec`).

> Toda vez que alterar o código, use **Implantar → Gerenciar implantações → editar (lápis) → Nova versão** para publicar a mudança na MESMA URL.

## 4. Conectar no app

1. Abra `app/index.html` (do projeto Lucro App).
2. No topo do script, troque:
   ```js
   var LICENSE = { endpoint: '', ... }
   ```
   por:
   ```js
   var LICENSE = { endpoint: 'https://script.google.com/macros/s/SEU_ID/exec', ... }
   ```
3. Salve e publique (commit + push). A partir daí a trava vale de verdade
   (o "modo teste" desliga sozinho quando o `endpoint` está preenchido).

## 5. Gerar chaves

- Na planilha, recarregue a página → aparece o menu **Lucro App**.
- **Lucro App → Gerar chaves…** → informe a quantidade.
- As chaves entram na aba **Chaves** com status `disponivel`.

---

## Como você opera o dia a dia

| Situação | O que fazer |
|---|---|
| Vendeu (manual) | Copie a próxima chave `disponivel`, marque `status=vendida`, ponha o e-mail, e envie a chave ao comprador. |
| Reembolso/chargeback | Selecione a linha da chave → **Lucro App → Revogar chave**. O app dela trava na próxima revalidação. |
| Cliente trocou de celular | Selecione a linha → **Lucro App → Resetar aparelhos** (zera os aparelhos; ele reativa). |
| Acabaram as chaves | **Gerar chaves…** de novo. |

## Aba "Ativacoes" (auditoria)

Cada tentativa vira uma linha: `data, chave, id_aparelho, resultado`
(`ok`, `limite`, `invalida`, `revogada`). Útil pra suporte e pra ver abuso.

## Entrega automática (opcional, depois)

Quando descobrir se o **Vaultly/Kiwify/Yampi** dispara webhook de venda:
aponte o webhook para a sua URL `/exec` com `acao=venda`. A função `handleVenda_`
pega a próxima chave `disponivel`, marca como `vendida` e **envia por e-mail** ao
comprador. O formato do payload muda por plataforma — me chame para adaptar a
extração do e-mail quando for ligar.

## Segurança (honesto)

- O limite de 2 aparelhos é garantido **no servidor** (a planilha é o juiz).
- O `token` é assinado (HMAC) com um segredo guardado em *Script Properties*
  (fora da planilha e do código).
- Como todo app client-side, um usuário técnico ainda consegue burlar localmente —
  mas o limite por aparelho **barra o compartilhamento casual de chave**, que é o objetivo.
