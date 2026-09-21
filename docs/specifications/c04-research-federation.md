# C-04: Pesquisa e Inventário de Federação Soberana

| Campo | Valor |
|---|---|
| Ciclo | C-04 — Federação real |
| Tarefa | T04-R |
| Responsável | Agente (A) |
| Data | 2026-09-21 |
| Status | Concluído — pronto para T04-S (C04-CONTRACT-1) |
| Rastreabilidade | R-08, I-03, I-04, I-06; V-06, V-07, V-08, V-12; E-06 |

---

## 1. Contexto e Objetivos da Pesquisa

O Ciclo C-03 estabeleceu a separação entre autorização e perspectiva, introduziu o registro soberano de projetos vinculados (`<selfRoot>/.holoself/links.json` sob schema v1), implementou a proteção contra sequestro de caminhos via `binding_salt`, a concorrência atômica via `withRegistryLock`, o catálogo particionado (schema v2) e o cache de decisão com invalidação estrita por `links_register_hash` (schema v3).

Contudo, a recuperação e a busca continuam estruturalmente limitadas ao arranjo binário `self + projeto local` (E-06). A pesquisa em T04-R tem por finalidade mapear exaustivamente todos os pontos do código onde essa premissa binária persiste, analisar as estruturas de cache, a resolução de identificadores compostos e potenciais colisões de caminhos, estabelecendo o checklist de integração e as bases normativas para o contrato formal C04-CONTRACT-1 (T04-S).

---

## 2. Inventário de Pontos Limitados a `self + projeto`

### 2.1 Ponto Crítico 1: `contextData` (`src/ecosystem.mjs:850-1400`)

1. **Resolução de Identidade Singleton e Espaços Acessíveis:**
   - Em `src/ecosystem.mjs:926-931`:
     ```javascript
     const subject = {
       kind: identity.kind,
       space_id: identity.kind === 'owner:direct' ? 'self' : canonicalSpaceId(project),
       accessible_spaces: identity.kind === 'owner:direct' ? ['self', 'contrib'] : [canonicalSpaceId(project)],
       effective_allowed_lenses: identity.allowedLenses
     }
     ```
     Para `client:linked`, `accessible_spaces` contém unicamente o espaço do projeto consumidor corrente. Projetos pares (*peers*) não são contemplados.
   - Para `owner:direct`, `identity.project` é `null` e nenhuma partição de projeto é inspecionada, restringindo a busca soberana a `self + contrib`.

2. **Invocação e Estrutura de Partições em `ensureCatalog`:**
   - Em `src/ecosystem.mjs:934-935`:
     ```javascript
     const projectForCatalog = identity.kind === 'client:linked' ? project : null
     const catResult = ensureCatalog(self, projectForCatalog, link, registry, { rebuild: false })
     ```
     `ensureCatalog` é invocado passando exclusivamente `projectForCatalog` (um único projeto) e `link` (o link local). Não há mecanismo para carregar catálogos de outros projetos registrados.

3. **Coleta de Candidatos:**
   - Em `src/ecosystem.mjs:936-954`:
     ```javascript
     const selfData = catalogCandidateRecords(catResult.self, self, 'self', lens, ...)
     const local = (identity.kind === 'client:linked' && ...) ? catalogCandidateRecords(catResult.project, project, 'project', ...) : ...
     const candidates = [...selfData.records, ...local.records, ...contribCandidates]
     ```
     Apenas `self`, `project` local e `contrib` alimentam a lista `candidates`. Qualquer projeto par registrado em `links.json` é ignorado.

4. **Cômputo de `catalog_hash` para Cache de Decisão:**
   - Em `src/ecosystem.mjs:962-965`:
     ```javascript
     const catalog_hash = hash(canonicalJson({
       self: (catResult.self?.sources || []).map(s => [s.source_ref.source_id, s.source_ref.revision]),
       project: (catResult.project?.sources || []).map(s => [s.source_ref.source_id, s.source_ref.revision])
     }))
     ```
     O hash de catálogo é estruturado com chave estática `{ self, project }`. Se projetos federados forem consultados, qualquer alteração em um projeto par deixaria de invalidar o cache de decisão caso a estrutura não agregue todos os espaços participantes.

5. **Projeção e Serialização de Resposta:**
   - Em `src/ecosystem.mjs:1326-1354`:
     - O resultado projeta `self: selfProjection`, `project: projectProjection`, `methods: methodRecords`.
     - Não há container para `spaces` ou fontes federadas de múltiplos projetos produtores.
   - Em `packetFormat` (`src/ecosystem.mjs:1399`):
     ```javascript
     const docs = [
       ...data.self.documents.map(x => ({ ...x, owner: 'self' })),
       ...data.project.documents.map(x => ({ ...x, owner: 'project' })),
       ...(data.methods?.documents || []).map(x => ({ ...x, owner: 'method' }))
     ]
     ```
     O agregador formata apenas `self`, `project` e `method`. Documentos de projetos pares não possuem atribuição.

### 2.2 Ponto Crítico 2: `ensureCatalog` (`src/ecosystem.mjs:1939-1966`)

- A assinatura atual:
  ```javascript
  function ensureCatalog(selfRoot, projectDir, link, registry, options = {})
  ```
  assume explicitamente que existe no máximo um `projectDir`.
- O retorno é fixo: `{ self, project, contrib, fresh, skippedSecrets, warnings, catalog_reads }`.
- Não suporta carregar um conjunto arbitrário de espaços autorizados nem isolar falhas de I/O em espaços pares sem quebrar o retorno principal.

### 2.3 Ponto Crítico 3: `searchIndex` e MCP Search (`src/ecosystem.mjs:2002-2100`, `2784-2786`)

- Em `src/ecosystem.mjs:2002-2035`, `searchIndex` recebe um único objeto `index` (`index.entries` ou `index.sources`).
- No comando CLI `search` (`src/ecosystem.mjs:2784-2786`):
  ```javascript
  const project = projectPath(o), link = readLink(project), registry = loadLensRegistry(link.path),
        lens = o.lens || 'general', resolution = resolveLens(registry, lens),
        index = readIndex(project);
  let results = searchIndex(index, query, lens, registry, resolution, o.temporal || 'current')
  ```
  Lê exclusivamente o índice local do projeto consumidor.
- Na MCP Tool `holoselfMcpSearch` (`src/ecosystem.mjs:2095-2100`):
  Lê unicamente `readIndex(linked, true, false)`. A flag `input.federated` apenas deduplica resultados dentro daquele mesmo índice único:
  ```javascript
  if(input.federated){
    const seen = new Set();
    results = results.filter(item => {
      const key = `${item.provenance}:${item.matching_passage}`;
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  ```
  Isso comprova cabalmente a evidência E-06 apontada em `context-and-lenses-vnext.md`.

### 2.4 Ponto Crítico 4: Parsing de Opções e Interface CLI (`src/cli.mjs`)

- `parse(args)` possui a flag `--federated` (`o.federated = true`, linha 115), mas não suporta a especificação explícita de espaços via `--spaces <lista>` (ex.: `--spaces self,project-a,project-b`).
- `context` não repassa `o.federated` para `contextData` nem expõe configuração de escopo de federação.

---

## 3. Caches Globais e Locais: Análise de Isolamento e Invalidação

### 3.1 Localização dos Caches
- Catálogo:
  - `<selfRoot>/.holoself/runtime/catalog.json` (partição do self).
  - `<projectDir>/.holoself/runtime/catalog.json` (partição de cada projeto).
  - `<selfRoot>/.holoself/runtime/contrib.json` (partição de contribs).
- Cache de Decisão de Contexto:
  - Armazenado em `<projectDir>/.holoself/runtime/context-cache/<decisionKey>.json`.
  - Para `owner:direct` operando no self, atualmente `cacheDir` é `null` (desativado ou sem diretório fixado de projeto).

### 3.2 Vulnerabilidade de Cache na Federação Multi-Espaço
- **Chave de Decisão (`computeDecisionCacheKey`):**
  - Campos atuais: `catalog_hash`, `lens_registry_hash`, `contrib_selection_hash`, `links_register_hash`, `identity_id`, `lens`, `allowed_lenses`, `task_hash`, `temporal`, `include_history`, `budget`, `manifest`, `requested_source_ids`, `cursor`.
  - Graças a C-03 (S10-1, N7-1), `links_register_hash` já integra obrigatoriamente a chave. Portanto, **qualquer revogação ou alteração em `links.json` (incluindo revogação de projetos pares) altera deterministicamente a chave de cache**, invalidando entradas antigas.
  - **Porém**, `catalog_hash` precisa ser generalizado: se o projeto par `B` sofrer alteração em um documento Markdown, seu catálogo mudará. O `catalog_hash` do consumidor `A` DEVE incorporar as revisões de todos os catálogos consultados na federação:
    $$\text{catalog\_hash} = \text{sha256}\left(\text{canonicalJson}\left(\left[\left[\text{space\_id}_1, \dots\right], \left[\text{space\_id}_2, \dots\right]\right]\right)\right)$$
    Caso contrário, edições no produtor serviriam dados estáticos cacheados pelo consumidor.

---

## 4. Identificadores Compostos e Colisão de Caminhos

### 4.1 Estrutura Canônica de Identificadores (C-02 / C-03)
1. **Space ID (`space_id`):**
   - Self: `"self"`
   - Contrib: `"contrib"`
   - Projetos: `"hs-space-" + sha256("project\0" + canonical_project_path).slice(0, 16)`
2. **Source ID (`source_id`):**
   - Derivado em `sourceRef(spaceId, relPath, contentHash, sectionId)` (`src/catalog.mjs:57-67`):
     ```javascript
     const normalized = slash(relPath).normalize('NFC')
     const canonicalPath = process.platform === 'win32' ? normalized.toLowerCase() : normalized
     const sourceId = `hs-${sha256(spaceId + '\0' + canonicalPath).slice(0, 20)}`
     ```
   - **Garantia Anti-Colisão:** O `spaceId` é inserido com separador nulo `\0` antes do caminho relativo.
   - **Consequência:** Dois projetos diferentes contendo o arquivo `README.md` geram `source_id`s matematicamente distintos e não colidentes.
3. **Section ID (`section_id`):**
   - Formato relativo: `${baseSlug}` ou `${baseSlug}-${count}`.
   - No envelope e no recibo federado, o identificador composto global é representado via `SourceRef`:
     `{ space_id, source_id, revision, section_id }`
     ou string composta `${space_id}:${source_id}`.

### 4.2 Deduplicação e Regra de Não-Ampliação de Privilégios (I-03, I-06, V-06)
- **Cenário:** O mesmo documento (mesmo hash de conteúdo SHA-256) existe no Projeto Produtor Compartilhado `P_shared` e no Projeto Produtor Restrito `P_restricted`.
- **Regra Fundamental de Deduplicação:**
  A deduplicação **NUNCA DEVE PROMOVER DIREITOS NEM VAZAR EXISTÊNCIA**:
  1. O pipeline de autorização e filtragem executa **estritamente antes** de qualquer etapa de deduplicação ou ranking.
  2. O espaço `P_restricted` (ou documento restrito) é sumariamente bloqueado e eliminado do conjunto de candidatos.
  3. A deduplicação opera exclusivamente sobre os registros que foram legalmente autorizados pelas políticas de seus respectivos espaços.
  4. Caso o mesmo conteúdo exista em dois espaços legalmente acessíveis ao consumidor (ex.: `self` e `P_shared`):
     - A precedência determinística favorece:
       1º: Espaço local do projeto consumidor (`client:linked`).
       2º: Espaço soberano (`self`).
       3º: Espaços federados pares ordenados alfabeticamente por `space_id`.
     - A atribuição no recibo e nas fontes entregues deve pertencer unicamente ao espaço vencedor, sem misturar procedências ou metadados de outros espaços.

---

## 5. Regras de Participação, Descoberta e Interseção

### 5.1 Descoberta Estrita de Espaços (I-03)
- É categoricamente vedado escanear diretórios vizinhos no sistema de arquivos.
- Os únicos espaços federáveis da identidade pessoal são aqueles explicitamente cadastrados no registro soberano `<selfRoot>/.holoself/links.json`.
- Uma entrada em `links.json` só é elegível para federação se:
  1. `status === "active"`.
  2. `binding_salt` for válido e corresponder a um link íntegro.
  3. O diretório apontado for validado contra path traversal e contenção.

### 5.2 Interseção Consumidor $\cap$ Produtor $\cap$ Documento
Para uma consulta sob a lente $L$ solicitada pelo projeto consumidor $C$:
1. **Lente Autorizada para o Consumidor:**
   $L \in L_{\text{consumer}}$ (onde $L_{\text{consumer}} = link_C.\text{lenses} \cap registry_C.\text{allowed\_lenses}$).
2. **Lente Compartilhada pelo Produtor:**
   Para cada projeto par $P \in links.json$:
   $L \in L_{\text{producer}}$ (onde $L_{\text{producer}}$ são as lentes concedidas a $P$ pelo proprietário em `links.json`).
   Se $L \notin L_{\text{producer}}$, o espaço $P$ **não compartilha conteúdo sob a lente $L$** e é sumariamente omitido da consulta sob essa perspectiva.
3. **Escopo de Leitura no Produtor:**
   - Documentos do produtor com `read_scope: "local"` são restritos ao espaço local do produtor e **nunca** são entregues a projetos pares.
   - Documentos com `read_scope: "restricted"` são restritos ao proprietário direto sob lente privada e **nunca** são entregues a projetos vinculados.
   - Portanto, apenas documentos com `read_scope: "shared"` e cuja lista `access_lenses` contenha $L$ são elegíveis para federação.

### 5.3 Garantia Anti-Oráculo para Espaços Restritos (V-06)
- Se um projeto registrado possuir status `revoked` ou não tiver a lente solicitada concedida em `links.json`:
  - Ele **não deve** aparecer em `result.sources`.
  - Ele **não deve** aparecer em `result.restrictions` (nenhum caminho, nome de diretório ou slug exposto).
  - Ele **não deve** aparecer em `result.warnings` nem em receipts.
  - Ele não gera qualquer pista de oráculo que permita ao consumidor inferir sua existência ou conteúdo.

---

## 6. Tratamento de Falhas e os Três Resultados Formais

O contrato C-04 exige a distinção rigorosa entre três comportamentos:

| Resultado | Condição Causal | Comportamento Exigido |
|---|---|---|
| **1. Parcial Seguro (`status: 'partial'`)** | Um projeto produtor par explicitamente cadastrado e ativo em `links.json` está fisicamente inacessível (ex.: disco externo desconectado, diretório excluído externamente, `ENOENT`, `EACCES`). | A consulta **não é abortada**. Os espaços saudáveis (`self`, projeto consumidor e demais pares ativos) entregam seu contexto normalmente. O resultado registra no recibo/envelope `status: "partial"` e lista o `space_id` em `unreachable_spaces`, sem vazar caminhos físicos não autorizados. |
| **2. Fonte Bloqueada (Blocked Source)** | Um documento específico dentro de um espaço acessível está corrompido, com frontmatter inválido, TOCTOU durante a entrega, violação de segredo ou hash divergente. | Apenas a fonte individual é bloqueada fail-closed (`delivery_reason`), mantendo o restante do espaço e da consulta em operação. |
| **3. Consulta Abortada (Fail-Closed)** | Falha na determinação da autoridade primária ou do escopo seguro: `links.json` ausente ou corrompido; `self` soberano inalcançável para validar permissões; incompatibilidade de `binding_salt` do próprio projeto consumidor. | A consulta inteira aborta com erro fatal (código `SOVEREIGN_REGISTRY_CORRUPT`, `LENS_NOT_GRANTED` ou `SECURITY_SCOPE_INDETERMINABLE`), impedindo qualquer entrega sob estado de autoridade duvidoso. |

---

## 7. Checklist de Integração para C-04

- [ ] **Módulo `catalog.mjs`:**
  - [ ] Generalizar `ensureCatalog` para suportar partição de múltiplos espaços federados.
  - [ ] Generalizar `catalog_hash` para serializar de forma canônica e determinística todos os espaços federados consultados: `[[space_id, [[source_id, revision], ...]], ...]`.
  - [ ] Assegurar validação e suporte a `status: 'partial'` e lista de `unreachable_spaces`.
- [ ] **Módulo `ecosystem.mjs`:**
  - [ ] Implementar resolução de espaços federados a partir de `<selfRoot>/.holoself/links.json`.
  - [ ] Implementar regra de interseção: $L \in L_{\text{consumer}} \cap L_{\text{producer}}$ e filtro estrito `read_scope === 'shared'`.
  - [ ] Implementar suporte a `--federated` e `--spaces <lista>` em `contextData`.
  - [ ] Assegurar que `subject.accessible_spaces` mantenha o isolamento de escopo `local`.
  - [ ] Implementar busca federada real em `searchIndex` e `holoselfMcpSearch` percorrendo os catálogos dos espaços participantes.
  - [ ] Integrar deduplicação determinística anti-ampliação de privilégios.
  - [ ] Manter envelope serializado dentro dos limites de orçamento global (`small`/`standard`/`deep`).
- [ ] **Interface e Schemas:**
  - [ ] Atualizar schema de cache de decisão para suportar hashes de catálogos multi-espaço.
  - [ ] Suportar flag `--spaces` na CLI (`src/cli.mjs`).
  - [ ] Preservar 100% de compatibilidade retroativa com envelope existente (`self`, `project`, `methods`) adicionando projeção segura para espaços federados.
- [ ] **Suíte de Testes (T04-F):**
  - [ ] Criar `tests/federation.test.mjs` com fixture de 3 espaços sintéticos: consumidor, produtor compartilhado e produtor restrito (V-06).
  - [ ] Testar revogação de produtor e invalidação imediata do cache de decisão (V-07).
  - [ ] Testar produtor offline gerando resultado `partial` sem quebrar a consulta.
  - [ ] Testar integridade anti-oráculo: zero vazamento de metadados do produtor restrito.
