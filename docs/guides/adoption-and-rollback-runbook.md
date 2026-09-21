# Runbook de Adoção e Reversão (Adoption and Rollback Runbook)

Este documento fornece instruções práticas, verificadas e determinísticas para adotar o Holoself vNext em novos projetos, migrar repositórios existentes com segurança e executar procedimentos de reversão (rollback) sem perda de integridade.

---

## 1. Pré-Requisitos e Instalação

- **Runtime Requerido:** Node.js $\ge 20.0.0$ (ESM nativo).
- **Instalação Global / CLI:**
  ```bash
  npm install -g holoself-ai
  # ou execução direta a partir do código fonte:
  node bin/holoself.mjs <comando>
  ```
- **Verificação de Ambiente:**
  ```bash
  holoself doctor
  ```

---

## 2. Adoção em Projetos Novos

### 2.1 Inicialização da Raiz Soberana (Canonical Self Root)
A raiz canônica armazena os metadados pessoais, perfis e lentes do usuário:
```bash
holoself init --root ~/.holoself
```
Estrutura gerada:
- `config.json`: Configuração do produto e seleção de contribs.
- `profile/`: Documentos de identidade, voz, estilo e preferências.
- `context/`: Histórico profissional, evidências de liderança e projetos.
- `lenses/`: Definições customizadas opcionais.

### 2.2 Vinculação de um Projeto (Metadata Link)
Para conectar um projeto local à sua raiz canônica com escopo restrito de privacidade:
```bash
holoself link add --project /caminho/do/projeto --self ~/.holoself --lens general --yes
```
O comando cria de forma delimitada:
- `.holoself/link.yaml`: Configuração estrita de leitura e proposta.
- `.holoself/BOOTSTRAP.md`: Ponteiro de inicialização para ferramentas de IA.
- Marcadores de ativação nos arquivos de instruções detectados (`AGENTS.md`, `CLAUDE.md`, etc.).

### 2.3 Ativação no Servidor MCP
Para clientes compatíveis com o Model Context Protocol (Anthropic Claude Desktop, Cursor, Antigravity, etc.):
```json
{
  "mcpServers": {
    "holoself": {
      "command": "holoself",
      "args": ["mcp", "--project", "/caminho/do/projeto"]
    }
  }
}
```
A ferramenta recomendada para agentes é a **`holoself_context`**, que entrega contexto filtrado por lentes em uma única invocação.

---

## 3. Migração de Repositórios Existentes

### 3.1 Migração de Políticas de Acesso Legadas (`visibility` $\rightarrow$ `access_lenses`)
Se o seu repositório utiliza metadados legados com campos `visibility: linked-projects` ou `public_safe: true`:

1. **Simulação e Planejamento (Dry-Run):**
   ```bash
   holoself migrate policy --root ~/.holoself --dry-run
   ```
   Gera um plano de migração em `.holoself/migrations/plan-<id>.json` sem modificar nenhum arquivo.

2. **Aplicação com Confirmação de Estreitamento:**
   ```bash
   holoself migrate policy --root ~/.holoself --apply <plan_id> --confirm-narrowing
   ```
   - Assegura atomicidade em cada arquivo via buffers temporários (`atomicWriteFile`).
   - Grava um recibo assinado por hash em `.holoself/migrations/receipt-<id>.json`.

### 3.2 Migração de Montagens Legadas (Symlinks / Junções do Filesystem)
Se um projeto antigo utiliza `.holoself` como symlink ou junção direta do sistema de arquivos (modo D-05 `legacy-mount`):

1. **Diagnóstico sem I/O Perigoso:**
   ```bash
   holoself link status --project /caminho/do/projeto
   # Estado exibido: state: "legacy-mount"
   ```
2. **Migração Segura para Metadata Link:**
   - Via CLI:
     ```bash
     holoself unlink --target /caminho/do/projeto --root ~/.holoself --yes
     holoself link add --project /caminho/do/projeto --self ~/.holoself --lens general --yes
     ```
   - Via Workbench:
     Acesse `http://127.0.0.1:<porta>/#spaces` e clique no botão **"Migrate to metadata link"** no card do espaço.

---

## 4. Procedimentos de Reversão (Rollback Runbook)

### 4.1 Reversão Completa de Migração de Política
Se for necessário reverter as alterações de metadados de uma migração aplicada:
```bash
holoself migrate policy --root ~/.holoself --revert <receipt_id>
```
- O runtime verifica o selo de integridade `applied_entries_digest`.
- Restaura os arquivos para seus conteúdos exatos anteriores (`before_text`).
- Atualiza o status do recibo para `reverted`.

### 4.2 Reversão Parcial Tolerante a Alterações Concorrentes
Caso alguns arquivos tenham sido editados manualmente após a migração:
```bash
holoself migrate policy --root ~/.holoself --revert <receipt_id> --allow-partial
```
- Arquivos intactos são revertidos com segurança.
- Arquivos modificados após a migração são preservados sem sobrescrita forçada.
- O recibo é marcado como `partially-reverted`.

### 4.3 Desativação e Desvinculação de Projetos
Para revogar o acesso de um projeto sem apagar ou corromper arquivos pessoais:
```bash
holoself link remove --project /caminho/do/projeto --yes
```
- Remove de forma limpa as instruções gerenciadas e a configuração local `.holoself/link.yaml`.
- Atualiza o registro central soberano (`links.json`) na raiz canônica, marcando o projeto como `revoked`.
- Todos os arquivos do projeto fora de `.holoself` permanecem estritamente intactos.
