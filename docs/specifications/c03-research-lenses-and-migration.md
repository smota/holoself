# T03-R: Inventário de Schemas, Sensibilidade, Publicação, Bases Customizadas, Parsers Legados e Tabela de Precedência

| Campo | Valor |
|---|---|
| Tarefa | T03-R (Ciclo C-03 — Lentes como Perspectivas e Migração) |
| Autor / Agente | A (Pesquisa e Inventário) / Q (Coordenação e Arquitetura) |
| Data | 2026-09-20 |
| Baseline | Ciclo C-02 aprovado por Claude Opus (`task-2919`, 204/204 testes verdes) |
| Escopo | R-01, R-03, R-12; A-01, A-02, A-07; V-04, V-05, V-10, V-12; decisões D-01, D-03, D-07 |

---

## 1. Inventário Exaustivo dos Schemas de Política e Vínculo

### 1.1 `schemas/link.schema.json` (Vínculo de Projeto Ativado)
- **Localização:** `schemas/link.schema.json` (34 linhas)
- **Propósito:** Governa o arquivo `.holoself/link.yaml` em projetos vinculados a um repositório canônico (`self`). (Nota: `.holoself/config.json` é o manifesto de configuração da raiz do `self`).
- **Campos e Regras Estruturais:**
  - `self_context` (obrigatório):
    - `path` (string, minLength: 1): caminho para o `selfRoot`.
    - `access`: constante `"read"`.
    - `proposals`: enum `["enabled", "disabled"]`.
    - `index`: constante `"local"`.
    - `default_lens` (string, pattern `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, maxLength: 40): lente padrão do projeto.
    - `secondary_lenses` (array opcional de IDs de lentes com `uniqueItems: true`).
  - `project_context` (opcional):
    - `include`, `exclude`, `assert_include`, `assert_exclude`: listas de padrões glob/path.
- **Lacunas e Ambiguidades Identificadas para C-03:**
  1. *Ausência de Atestação do Vínculo pelo Self:* O vínculo é gravado unicamente no lado do projeto (`<projectDir>/.holoself/link.yaml`). O diretório `self` não mantém registro formal de quais projetos têm permissão de vinculação (`D-03`), permitindo que qualquer processo local aponte um `link` para o `self` desde que possua permissão de leitura no filesystem.
  2. *Escopo de Leitura Acoplado à Lente:* O vínculo restringe acesso via `default_lens` e `secondary_lenses`, fundindo a **perspectiva de relevância/ranking** com o **grant de autorização de leitura** (`D-01`).

---

### 1.2 `schemas/lens.schema.json` (Definição de Lente Customizada)
- **Localização:** `schemas/lens.schema.json` (20 linhas)
- **Propósito:** Validação de lentes definidas pelo usuário em `<selfRoot>/lenses/<id>.json`.
- **Campos e Regras Estruturais:**
  - `schema_version`: constante `1`.
  - `id`: identificador kebab-case (maxLength: 40), explicitamente proibido de colidir com as 7 embutidas (`general`, `career`, `publishing`, `technical`, `leadership`, `interview`, `private`).
  - `title`: string não vazia.
  - `base_lens`: enum estrito das 7 lentes embutidas.
  - `sensitivity_access`: array com `uniqueItems: true`, restrito a:
    `["compensation-confidential", "third-party-personal", "recruiter-confidential", "employer-confidential", "application-private"]`.
  - Proibição expressa: `"restricted"` **não é permitido** em lentes customizadas.
- **Lacunas e Ambiguidades Identificadas para C-03:**
  1. *Lente Customizada Herda Comportamento mas NÃO Herda Concessão:* Um documento com `access_lenses: [publishing]` **não é acessível** sob uma lente customizada que tenha `base_lens: "publishing"`. A função `allowed()` em `src/ecosystem.mjs:375` exige que o ID exato da lente customizada conste na lista `access_lenses` do documento.
  2. *Assimetria de Sensibilidade vs Embutidas:* Lentes customizadas recebem sensibilidades por lista opt-in explícita (`sensitivity_access`), enquanto lentes embutidas recebem sensibilidade pelo mapeamento hardcoded `SENSITIVITY_LENSES`.

---

### 1.3 `schemas/document-metadata.schema.json` (Metadados Canônicos de Frontmatter)
- **Localização:** `schemas/document-metadata.schema.json` (56 linhas)
- **Propósito:** Validação dos metadados YAML dos arquivos Markdown em `self` e `project`.
- **Campos Obrigatórios Modernos:**
  - `access_lenses`: array não-vazio de identificadores estruturalmente válidos.
  - `disclosure`: enum `["internal-only", "review-required", "publish-approved"]`.
  - `sensitivity`: enum `["public", "personal", "compensation-confidential", "third-party-personal", "recruiter-confidential", "employer-confidential", "application-private", "restricted", "none"]`.
  - `document_role`: enum `["policy", "evidence", "content"]`.
- **Campos Legados de Compatibilidade:**
  - `visibility`: enum `["private", "linked-projects", "career", "publishing", "public-safe"]`.
  - `public_safe`: boolean.
- **Campos Temporais e de Ciclo de Vida:**
  - `knowledge_status`: `["current", "historical", "superseded"]` (default: `"current"`).
  - `temporal_scope`: `["current", "time-bounded", "historical", "timeless"]` (default: `"current"`).
  - `valid_from`, `valid_until`, `review_after`: datas ISO.
  - `supersedes`, `superseded_by`: referências de linhagem.
- **Campos de Controle Interno e Fatiamento:**
  - `field_visibility`: mapa de cabeçalhos/campos para níveis de `visibility`.
  - `task_include`, `task_exclude`, `confidence`, `exclude_lenses`.

---

## 2. Inventário de Sensibilidade, Divulgação e Publicação

### 2.1 Categorias de Sensibilidade e Agrupamentos
Existem 9 categorias formais de sensibilidade definidas em `src/annotations.mjs:3`:
1. `public`: Acesso irrestrito em qualquer contexto autorizado.
2. `none`: Ausência de restrição de sensibilidade.
3. `personal`: Dados de vida pessoal ordinária; acessíveis por padrão pelo proprietário e lentes ordinárias, mas **não são confidenciais corporativos**.
4. `compensation-confidential`: Salários, propostas, pacotes de remuneração, ações.
5. `third-party-personal`: Dados pessoais de terceiros (colegas, liderados, clientes).
6. `recruiter-confidential`: Conversas com recrutadores, avaliações sigilosas de processos seletivos.
7. `employer-confidential`: Segredos comerciais, propriedade intelectual e diretrizes confidenciais de empregadores.
8. `application-private`: Dados internos de aplicações e credenciais/tokens de uso interno.
9. `restricted`: Máximo sigilo; **somente a lente embutida `private`** pode acessar. Proibido em lentes customizadas.

`CONFIDENTIAL_SENSITIVITIES` (`src/annotations.mjs:6`):
Agrupa as categorias 4 a 9. Qualquer combinação de `disclosure: "publish-approved"` com uma dessas categorias resulta em erro de validação fail-closed (`src/annotations.mjs:37`).

### 2.2 Mapeamento de Sensibilidade x Lentes Embutidas (`SENSITIVITY_LENSES`)
Definido em `src/ecosystem.mjs:57-64`:
```javascript
const SENSITIVITY_LENSES = {
  'compensation-confidential': ['career', 'interview', 'private'],
  'third-party-personal': ['leadership', 'private'],
  'recruiter-confidential': ['career', 'interview', 'private'],
  'employer-confidential': ['career', 'technical', 'leadership', 'interview', 'private'],
  'application-private': ['career', 'interview', 'private'],
  'restricted': ['private']
}
```
*Observação Crítica:* As sensibilidades `public`, `none` e `personal` **não constam** em `SENSITIVITY_LENSES`. Consequentemente, para essas três categorias, a sensibilidade não atua como bloqueador de lente; a decisão recai exclusivamente sobre `access_lenses` e `disclosure`.

### 2.3 Divulgação e Adapters de Publicação
Três valores de `disclosure`:
- `internal-only`: Contexto estritamente interno; jamais exportável para adapters públicos.
- `review-required`: Requer revisão humana explícita antes de publicação.
- `publish-approved`: Conteúdo formalmente liberado para publicação pública.

Adapters públicos (`obsidian-public`, `public`, `restricted-host`):
Avaliados em `src/ecosystem.mjs:368,382`:
```javascript
function publicationAllowed(meta){
  return disclosure(meta) === 'publish-approved' && 
         !CONFIDENTIAL_SENSITIVITIES.includes(meta.sensitivity || '')
}
```
Se `publicationAllowed(meta)` for falso, qualquer consulta originada de adapter público omite a fonte sumariamente.

---

## 3. Bases Customizadas e Resolução de Lentes (`src/lenses.mjs`)

### 3.1 Registro de Lentes e Estrutura em Disco
- Diretório de registro: `<selfRoot>/lenses/`
- Arquivos de definição: `<selfRoot>/lenses/<id>.json`
- Arquivos de instruções: `<selfRoot>/lenses/instructions/<id>.json`
- Hash do registro (`registry_hash`): SHA-256 canônico calculado sobre todos os pares `[filename, sha256(raw_content)]`, ordenados alfabeticamente.

### 3.2 Lentes Embutidas vs Customizadas
| Lente | Fonte | Base Lens | Categorias de Sensibilidade Acessíveis |
|---|---|---|---|
| `general` | builtin | `general` | Nenhuma confidencial (apenas `public`, `none`, `personal`) |
| `career` | builtin | `career` | `compensation-confidential`, `recruiter-confidential`, `employer-confidential`, `application-private` |
| `publishing` | builtin | `publishing` | Nenhuma confidencial; sanitização de compensação ativada |
| `technical` | builtin | `technical` | `employer-confidential` |
| `leadership` | builtin | `leadership` | `third-party-personal`, `employer-confidential` |
| `interview` | builtin | `interview` | `compensation-confidential`, `recruiter-confidential`, `employer-confidential`, `application-private` |
| `private` | builtin | `private` | Todas as 6 confidenciais + `restricted` |
| `<custom>` | registry | `base_lens` | Subconjunto declarado em `sensitivity_access` (exceto `restricted`) |

### 3.3 Mecânica de Resolução e Comportamento Efetivo
A resolução da lente (`resolveLens` + `ecosystem.mjs:378-445`) decompõe a lente em:
1. `lens`: O identificador nominal da lente atual (usado para checar se está listado em `access_lenses`).
2. `behaviorLens` (`resolution?.base_lens || lens`): A lente embutida que dita as regras operacionais de redação (ex.: regras de compensação de `publishing`).
3. `resolution.sensitivity_access`: Lista declarada de categorias sensíveis permitidas para lentes customizadas.

---

## 4. Parsers Legados e Mecanismos de Coexistência

### 4.1 Parser de Metadados e `frontmatter()`
Localizado em `src/ecosystem.mjs:300-349`:
- Documentos em `self`: Modo estrito (`tolerant: false`). Metadados inválidos, ausentes ou com erros semânticos quarentenam a fonte e emitem restrição fail-closed.
- Documentos em `project`: Modo tolerante (`tolerant: true`). Frontmatter malformado ou ausente recebe fallback automático para documento seguro de projeto sem derrubar a execução.

### 4.2 Mapeamento de Compatibilidade Legada (`legacyAccessLenses` e `visibility`)
Quando um documento antigo possui apenas `visibility` e omite `access_lenses`:
```javascript
function legacyAccessLenses(meta){
  const v = visibility(meta) // default: 'linked-projects'
  if (v === 'private') return ['private']
  if (v === 'career') return ['general', 'career', 'interview', 'private']
  if (v === 'publishing') return ['general', 'publishing', 'private']
  return [...LENSES] // 'linked-projects', 'public-safe' mapeiam para todas as 7 lentes
}
```
E para `disclosure`:
```javascript
function disclosure(meta){
  if (meta.public_safe === false) return 'review-required'
  if (DISCLOSURES.includes(meta.disclosure)) return meta.disclosure
  if (meta.public_safe === true || visibility(meta) === 'public-safe') return 'publish-approved'
  return 'internal-only'
}
```

---

## 5. Tabela de Precedência Atual e Ambiguidades Arquiteturais Identificadas

### 5.1 Tabela de Precedência Atual de Avaliação de Acesso (`src/ecosystem.mjs:374-384`)

A função `allowed(meta, lens, adapter, task, resolution)` aplica os seguintes gates em ordem estrita:

| Ordem | Gate de Validação | Condição de Recusa (*Fail-Closed*) | Motivo Emitido em `restrictions[]` |
|---|---|---|---|
| **1** | **Presença na Lente** | `!accessLenses(meta).includes(lens)` | `access_lenses exclude <lens> lens` |
| **2** | **Exclusão Explícita de Lente** | `(meta.exclude_lenses || []).includes(lens)` | `access_lenses exclude <lens> lens` |
| **3** | **Filtro de Tarefa** | `!taskAllowed(meta, task)` | `task selector excludes <task>` |
| **4** | **Sensibilidade Custom: Restricted** | `custom && meta.sensitivity === 'restricted'` | `sensitivity restricted excludes <lens> lens` |
| **5** | **Sensibilidade Custom: Categoria** | `custom && SENSITIVITY_LENSES[sens] && !resolution.sensitivity_access.includes(sens)` | `sensitivity <sens> excludes <lens> lens` |
| **6** | **Sensibilidade Embutida (não-política)** | `!custom && documentRole(meta) !== 'policy' && SENSITIVITY_LENSES[sens] && !SENSITIVITY_LENSES[sens].includes(lens)` | `sensitivity <sens> excludes <lens> lens` |
| **7** | **Adapter Público** | `isPublicAdapter(adapter) && !publicationAllowed(meta)` | `not publish-approved` / `not publication-approved` |

*Nota de Implementação sobre Atribuição de Motivo (N-4):*
Em `src/ecosystem.mjs:437`, a razão atribuída em `restrictions[]` para chamadores proprietários (`owner:direct`) segue a primeira fase com falha. Para chamadores vinculados (`client:linked`), motivos detalhados de restrição de existência e sensibilidade confidencial são suprimidos (*fail-closed* sem oráculo de erro, C-01 H-5/M-5), reportando apenas contadores agregados opacos (`unauthorized_sources_omitted`).

---

### 5.2 Ambiguidades e Gaps Arquiteturais Identificados para Resolução em C-03 (D-01, D-03, D-07)

#### Ambiguidade 1: Confusão entre Lente (Perspectiva) e Grant (Autorização) (D-01)
- **Problema:** No modelo atual, para um documento ser acessível por uma lente, o documento precisa explicitar o ID da lente em seu frontmatter (`access_lenses: [minha-lente]`).
- **Impacto:** Se o usuário cria uma nova lente customizada (ex: `arquitetura-cloud`), **nenhum documento existente é acessível**, mesmo documentos públicos ou técnicos compartilhados, a menos que o usuário edite o frontmatter de cada documento para adicionar `arquitetura-cloud`.
- **Diretriz C-03 (D-01):** Separar a autorização de leitura (`read_scope: shared | local | restricted`) da perspectiva de ranking/relevância (`lens_id`). A lente é uma perspectiva que rankeia e projeta; o direito de leitura pertence ao sujeito e espaço sobre o documento.

#### Ambiguidade 2: Assimetria de `documentRole: 'policy'` entre Embutidas e Customizadas
- **Problema:** Na regra 6 (`ecosystem.mjs:381`), documentos com `documentRole: 'policy'` ignoram a checagem de sensibilidade sob lentes embutidas (ex.: uma política com `sensitivity: employer-confidential` é legível sob `general`). Porém, na regra 5 (`ecosystem.mjs:380`), lentes customizadas não possuem essa exceção (`custom && SENSITIVITY_LENSES[sensitivity] && !resolution.sensitivity_access.includes(sensitivity)`), bloqueando a política.
- **Diretriz C-03:** Unificar a semântica de `document_role: 'policy'` para que a regra de precedência seja homogênea e determinística.

#### Ambiguidade 3: Mapeamento Excessivamente Amplo do Legado `visibility: linked-projects` (D-07)
- **Problema:** Na regra legada `legacyAccessLenses`, qualquer documento sem `access_lenses` com `visibility: linked-projects` mapeia para `[...LENSES]` (todas as 7 lentes embutidas, incluindo `private`, `career`, `leadership`, `interview`).
- **Impacto:** Um documento antigo criado sem atenção recebe exposição para lentes de alto privilégio.
- **Diretriz C-03 (D-07):** Na migração de dados históricos, mapear `visibility: linked-projects` para escopo compartilhado de projeto explícito sem conceder automaticamente lentes estritamente privadas ou restritas.

#### Ambiguidade 4: Falta de Adesão Bidirecional nos Vínculos de Projetos (D-03)
- **Problema:** O arquivo de link é gravado apenas no projeto (`<projectDir>/.holoself/link.yaml`). O `self` não tem ciência nem controle de quais projetos estão ativamente consumindo seu conhecimento.
- **Diretriz C-03 (D-03):** O contrato de participação deve exigir registro opt-in no lado do `self` (ou atestação de vínculo), evitando vazamento passivo por simples criação de pasta de projeto apontando para o `self`.

#### Ambiguidade 5: Migração Segura, Idempotente e Reversível (R-12, V-10)
- **Problema:** A migração de frontmatter de documentos existentes do modelo legado para o modelo moderno pode corromper texto ou sobrescrever alterações se não houver verificação criptográfica de estado.
- **Diretriz C-03 (R-12, V-10):** A ferramenta de migração deve oferecer:
  1. `--dry-run` com exibição de diff e contagem de alterações sem tocar o filesystem.
  2. Execução transacional com hashes pré/pós (`sha256(before) -> sha256(after)`).
  3. Capacidade de reversão automática (`--revert <plan>`) assegurando que nenhum byte não-planejado seja modificado.

---

## 6. Próximo Passo Normativo
A entrega da pesquisa T03-R prepara os subsídios completos para a tarefa **T03-S (Especificação do Contrato C03-CONTRACT-1 e fechamento das decisões D-01, D-03 e D-07)**, a ser revisada formalmente pelo Claude Opus em **T03-V**.
