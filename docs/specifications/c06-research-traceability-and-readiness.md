# C-06: Pesquisa de Rastreabilidade, Regressão e Prontidão para Adoção (T06-R)

Este documento registra a pesquisa e auditoria formal da etapa **T06-R** do ciclo **C-06** da especificação `context-and-lenses-vnext` e do plano de implementação (`docs/specifications/context-and-lenses-implementation-plan.md`).

---

## 1. Auditoria de Rastreabilidade Ponta a Ponta (R-01 a R-12)

| Requisito | Descrição Normativa | Ciclo & Contrato | Componentes de Código / Diff | Suites de Testes / Oráculos | Critérios de Aceite Vinculados | Status |
|---|---|---|---|---|---|---|
| **R-01** | Separação estrita entre aquisição de metadados (`manifest`) e expansão de corpos (`get`), impedindo leitura antecipada. | C-02 (C02-CONTRACT-1) | `src/catalog.mjs`, `src/ecosystem.mjs`, `src/mcp-server.mjs` | `tests/catalog.test.mjs`, `tests/mcp.test.mjs`, `tests/efficiency.test.mjs` | **V-01, V-02** | **Aprovado** |
| **R-02** | Catálogo indexado com hashes SHA-256 de origem, busca determinística e cache estruturado de decisões de seleção. | C-02 (C02-CONTRACT-1) | `src/catalog.mjs`, `src/context-selection.mjs` (`cachedSelection`) | `tests/catalog.test.mjs`, `tests/efficiency.test.mjs` | **V-01, V-08, V-11** | **Aprovado** |
| **R-03** | Sistema de Lentes Soberanas e Customizadas com validação estrita contra bases built-in e sem escalonamento implícito. | C-03 (C03-CONTRACT-1) | `src/lenses.mjs`, `src/ecosystem.mjs`, `schemas/lens.schema.json` | `tests/lenses.test.mjs`, `tests/web-project.test.mjs` | **V-04, V-05** | **Aprovado** |
| **R-04** | Migração determinística de metadados legados (`visibility`/`public_safe`) para Schema v1 com confirmação de estreitamento e recibos reversíveis. | C-03 (C03-CONTRACT-1) | `src/migration.mjs`, `schemas/migration-plan.schema.json`, `schemas/migration-receipt.schema.json` | `tests/migration.test.mjs` | **V-10** | **Aprovado** |
| **R-05** | Consulta orientada à tarefa com entrega completa em round-trip único (`holoself context` e MCP `holoself_context`) e gate determinístico PT/EN. | C-05 (C05-CONTRACT-1) | `src/context-selection.mjs` (`contextNeed`), `src/mcp-server.mjs` (`holoself_context`), `src/ecosystem.mjs` | `tests/mcp.test.mjs`, `tests/c00-baseline.test.mjs` (36 casos PT/EN) | **V-09, V-03** | **Aprovado** |
| **R-06** | Federação soberana multi-espaço com Merkle root (`catalog_hash`), registro com lock exclusivo e isolamento anti-oráculo V-06. | C-04 (C04-CONTRACT-1) | `src/ecosystem.mjs` (`withRegistryLock`, `ensureCatalogPartition`), `schemas/links-registry.schema.json` | `tests/federation.test.mjs` | **V-06, V-07** | **Aprovado** |
| **R-07** | Resiliência determinística a falhas parciais: status `partial` com `unreachable_spaces` opaco para pares, fail-closed soberano. | C-04 (C04-CONTRACT-1) | `src/ecosystem.mjs` (`contextData`, `healthStatus`) | `tests/federation.test.mjs` | **V-06, V-08** | **Aprovado** |
| **R-08** | Tetos rígidos de envelope UTF-8 por orçamento (`small` 16 KiB, `standard` 48 KiB, `deep` 128 KiB) e truncamento gradual seguro por relevância. | C-01 & C-05 | `src/context-selection.mjs` (`selectContextRecords`), `src/ecosystem.mjs` | `tests/c01-parity-and-envelope.test.mjs`, `tests/c00-baseline.test.mjs` | **V-03, D-06** | **Aprovado** |
| **R-09** | Interseção tripla de permissões ($L \in L_{\text{consumer}} \cap L_{\text{producer}} \cap \text{access\_lenses}(d)$) e filtro de `read_scope: "shared"`. | C-04 (C04-CONTRACT-1) | `src/ecosystem.mjs` (`filterClaimVisibility`, `visibleUnderBehavior`) | `tests/federation.test.mjs`, `tests/privacy-capabilities.test.mjs` | **V-06, V-12** | **Aprovado** |
| **R-10** | Consolidação de instruções de inicialização (`BOOTSTRAP.md`) e skill pública (`SKILL.md`) sem duplicação de regras de política em prosa. | C-05 (C05-CONTRACT-1) | `src/instructions.mjs`, `skills/holoself/SKILL.md` | `tests/docs.test.mjs`, `tests/ecosystem.test.mjs` | **V-12** | **Aprovado** |
| **R-11** | Proteção estrita do sistema de arquivos e caminhos: contenção em raiz (`assertContainedPath`), Zero-I/O em mounts legados (`lstatSync.isSymbolicLink()`). | C-01, C-04, C-05 | `src/ecosystem.mjs`, `src/web-server.mjs`, `src/mcp-server.mjs` | `tests/web-project.test.mjs`, `tests/cli.test.mjs` | **V-12, D-05** | **Aprovado** |
| **R-12** | Rastreabilidade e integridade criptográfica: hash canônico de contexto e tarefas (`context_hash`, `task_hash`) e recibos de execução rastreáveis. | C-01 & C-04 | `src/context-selection.mjs`, `src/migration.mjs` | `tests/c00-baseline.test.mjs`, `tests/migration.test.mjs` | **V-07, V-08** | **Aprovado** |

---

## 2. Auditoria da Matriz de Critérios de Verificação (V-01 a V-12)

1. **V-01 (Leituras de corpo durante entrega warm):**
   - *Exigência:* Zero leituras de arquivos de corpo não selecionados e $\le 10$ corpos lidos no perfil padrão warm.
   - *Implementação:* Cache estruturado em memória e disco com mapeamento por `source_id` e leitura sob demanda via `options.deliver`.
   - *Verificação:* Validado em `tests/catalog.test.mjs` e medido no harness C-00.
2. **V-02 (Zero-I/O no manifesto e expansão direcionada):**
   - *Exigência:* Geração de manifesto lê zero corpos de arquivos (`estimatedTokensBody: 0`); expansão lê estritamente os `source_ids` solicitados.
   - *Implementação:* Em `src/catalog.mjs` e `src/mcp-server.mjs`, `--manifest` e `holoself_context_manifest` projetam metadados sem acessar arquivos Markdown.
   - *Verificação:* Status `passed` no harness `c00-baseline.mjs` e em `tests/mcp.test.mjs`.
3. **V-03 (Conformidade com os limites de envelope UTF-8 D-06):**
   - *Exigência:* Payloads finais emitidos em CLI e MCP respeitam estritamente 16 KiB (small), 48 KiB (standard) e 128 KiB (deep).
   - *Implementação:* Medição em `Buffer.byteLength(JSON.stringify(payload), "utf8")` com descarregamento ordenado de documentos excedentes.
   - *Verificação:* Status `passed` no harness `c00-baseline.mjs` e `tests/c01-parity-and-envelope.test.mjs`.
4. **V-04 (Paridade CLI/MCP/Workbench e diagnósticos seguros):**
   - *Exigência:* Decisões idênticas de autorização e seleção em CLI, MCP e Workbench, com explicabilidade segura sem vazar fontes negadas.
   - *Implementação:* Todos os adaptadores invocam o mesmo núcleo soberano (`contextData` em `src/ecosystem.mjs` e `selectContextRecords`); Workbench sanitiza motivos de exclusão.
   - *Verificação:* Testado em `tests/web-project.test.mjs`, `tests/web-ui.test.mjs` e `tests/mcp.test.mjs`.
5. **V-05 (Protocolo de contribs e métodos customizados):**
   - *Exigência:* Seleção transparente de até 2 contribs relevantes como métodos; isolamento entre métodos públicos e locais (`contribs/local/`).
   - *Implementação:* Catalogação em `contribs/catalog.json`, checagem de limite em `selectContextRecords` e rejeição de métodos customizados não homologados.
   - *Verificação:* Auditado em `scripts/package-audit.mjs` e testado em `tests/docs.test.mjs`.
6. **V-06 (Federação soberana e interseção tripla anti-oráculo):**
   - *Exigência:* Preservação de privacidade entre espaços pares; documentos não autorizados não aparecem em contagens de restrição, listas de omissão ou timing.
   - *Implementação:* Interseção tripla de lentes em `filterClaimVisibility`; pré-filtro Zero-I/O in-memory antes de checar diretórios pares; supressão de `unauthorized_sources_omitted` para `client:linked`.
   - *Verificação:* Status `passed` no harness C-00 e 9/9 testes em `tests/federation.test.mjs`.
7. **V-07 (Revogação imediata e bloqueio de replay de cache):**
   - *Exigência:* A revogação de uma vinculação ou mudança de permissão invalida imediatamente caches e rejeita expansões de handles antigos.
   - *Implementação:* `links_register_hash` incluído na chave de cache e verificado na expansão de handles de paginação/manifesto; bloqueio de cursores replayed.
   - *Verificação:* `sourceRevocationBlocked: true` verificado em `c00-baseline.mjs` e `tests/federation.test.mjs`.
8. **V-08 (Invalidação incremental e escopo temporal):**
   - *Exigência:* Detecção de alterações de conteúdo mesmo com mesmo tamanho/mtime; invalidação por renomeação ou exclusão; suporte a expiração temporal.
   - *Implementação:* Hash SHA-256 de conteúdo no catálogo; `valid_until_epoch_ms` gravado na chave de cache; descarte sob alteração de estado.
   - *Verificação:* `sameSizeMtimeContentChangeDetected: true`, `deleteInvalidated: true`, `renameInvalidated: true` no baseline e `tests/catalog.test.mjs`.
9. **V-09 (Qualidade de entrega e gate mecânico PT/EN):**
   - *Exigência:* 36 de 36 casos congelados aprovados com 100% de sucesso; zero caracteres e leituras de corpos pessoais em tarefas mecânicas; preservação em tarefas ambíguas.
   - *Implementação:* `contextNeed` com padrões bilíngues Unicode-safe (`PERSONAL_PATTERN` e `MECHANICAL_PATTERN`); supressão de entrega de corpos pessoais em `not-needed`.
   - *Verificação:* **36 de 36 casos passaram (100%)** no harness `c00-baseline.mjs`; evidência E-07 resolvida (`reproduced: false, bodyChars: 0`).
10. **V-10 (Migração de política com recibos reversíveis):**
    - *Exigência:* Detecção de frontmatter legado; plano de migração com cálculo de impacto; confirmação explícita de estreitamento de acesso (`narrowingConfirmed`); recibo com reversão exata.
    - *Implementação:* Subcomando `holoself migrate policy --dry-run / --apply / --revert` em `src/migration.mjs`.
    - *Verificação:* 10/10 testes aprovados em `tests/migration.test.mjs`.
11. **V-11 (Limites de escala de cache e despejo determinístico):**
    - *Exigência:* Capacidade finita de cache em disco e memória com política LRU determinística, impedindo estouro de armazenamento.
    - *Implementação:* Limite máximo de 64 entradas no mapa de cache in-memory em `context-selection.mjs` e particionamento isolado no catálogo.
    - *Verificação:* Medições de armazenamento de cache coletadas e validadas no harness C-00.
12. **V-12 (Segurança de caminhos, defesas anti-injeção e privacidade):**
    - *Exigência:* Proibição de travessias de caminho fora da raiz (`assertContainedPath`); Zero-I/O em junções legadas (D-05); instruções não repetem regras em prosa; conteúdo recuperado não autoriza comandos.
    - *Implementação:* Funções utilitárias defensivas em `src/ecosystem.mjs` e checagem de symlinks via `lstatSync.isSymbolicLink()`.
    - *Verificação:* 35 testes específicos em `tests/privacy-capabilities.test.mjs` e validação de montagens em `tests/web-project.test.mjs`.

---

## 3. Auditoria de Esquemas JSON (`schemas/`)

Todos os esquemas da especificação foram verificados quanto à validade formal (JSON Schema Draft 2020-12) e conformidade com o código de produto:

1. `schemas/catalog.schema.json`: Estrutura do catálogo particionado, fontes, hashes e hashes de partição.
2. `schemas/context-decision-cache.schema.json`: Chave de cache, registros de decisão, validade temporal e orçamentos.
3. `schemas/document-metadata.schema.json`: Metadados Schema v1 (`access_lenses`, `disclosure`, `sensitivity`, `document_role`, `valid_until`, `supersedes`).
4. `schemas/lens.schema.json`: Registro soberano de lentes, bases built-in e sensitivity grants.
5. `schemas/link.schema.json`: Configuração de vinculação de projetos (`self_context`, `project_context`, `binding_salt`).
6. `schemas/links-registry.schema.json`: Registro central soberano de espaços vinculados, salts e revogações.
7. `schemas/migration-plan.schema.json`: Plano de migração de políticas de acesso e análise de estreitamento.
8. `schemas/migration-receipt.schema.json`: Recibo criptográfico de aplicação e reversão de migrações.

---

## 4. Auditoria de Empacotamento e Ausência de Dados Pessoais

- Execução de `node scripts/package-audit.mjs`:
  - `[ok] package paths and public defaults are clean`.
- Verificação de arquivos exportados no `package.json`:
  - Apenas diretórios de distribuição (`bin`, `src`, `web`, `skills`, `contribs`, `docs`, `schemas`, `templates`) e metadados de licença/documentação são empacotados.
  - Nenhum arquivo pessoal (`profile/`, `context/`, `.env`, chaves de API, senhas ou histórico) está presente na árvore de distribuição.
  - Testes e fixtures residem exclusivamente em `tests/` e são excluídos do pacote de publicação.
- Zero dependências npm externas em runtime: pure Node.js $\ge 20$.

---

## 5. Prontidão para o Aceite Integrado (C-06)

A arquitetura e os testes automatizados atingiram 100% de passagem (221/221 testes). As evidências observáveis comprovam a eliminação das fragilidades herdadas de HS-SPEC-001:
- E-01 (Manifest leak): Resolvido (zero bodies lidos no manifest).
- E-02 (Expansion over-read): Resolvido (apenas os handles solicitados são lidos).
- E-03 (Envelope overflow): Resolvido (orçamentos rígidos small/standard/deep).
- E-04 (Stale cache read): Resolvido (invalidação em delete, rename e same-size mtime).
- E-05 (Revocation ignored): Resolvido (revogação bloqueia cache e expansão).
- E-06 (Multi-space privilege escalation): Resolvido (interseção tripla e Zero-I/O em pares restritos).
- E-07 (Mechanical body leak): Resolvido (0 caracteres pessoais e 0 leituras de corpo em tarefas mecânicas).
- E-08 (Unvalidated lens access): Resolvido (validação estrita contra bases built-in).
