# T02-R: Rastreamento de Indexação, Seleção, Caches e Comparativo de Armazenamento Local

| Campo | Valor |
|---|---|
| Tarefa | T02-R (Ciclo C-02 — Catálogo Incremental e Cache Limitado) |
| Autor / Agente | Q (Coordenação e Arquitetura) / A (Pesquisa) |
| Data | 2026-09-20 |
| Baseline | `dee0fbf` (C-00 e C-01 verificados) |
| Escopo | R-06, R-07, R-11; A-03, A-04; gaps V-01, V-02, V-07, V-08, V-11; decisões D-02, D-06, D-08 |

---

## 1. Rastreamento dos Caminhos Atuais de Leitura, Indexação e Cache

### 1.1 `indexInputHash` e `indexFreshness` (`src/ecosystem.mjs:859-864`)
A verificação de frescor do índice atual é estruturalmente autodestrutiva em relação ao I/O:
```javascript
function indexInputHash(project, link=readLink(project), registry=loadLensRegistry(link.path)){
  const state=[]
  for(const [sourceKind, root, files] of [
    ['self', link.path, canonicalFiles(link.path, {includeHistory: true})],
    ['project', project, projectMarkdownFiles(project, link)]
  ]) {
    for(const file of files){
      const stat = statSync(file);
      state.push([sourceKind, slash(relative(root, file)), stat.size, stat.mtimeMs, hash(readFileSync(file, 'utf8'))])
    }
  }
  return hash(JSON.stringify({lens_registry_hash: registry.registry_hash, project_context: link.project_context, state: state.sort(...)}));
}
```
**Problema diagnosticado (E-02):**
Para apenas verificar se `index.json` está fresco (`indexFreshness`), a função invoca `indexInputHash`, que executa `readFileSync(file, 'utf8')` e `hash(...)` em **100% dos arquivos Markdown** de `self` e `project`. Logo, mesmo quando o índice está perfeitamente válido e nada foi alterado, todos os corpos são lidos do disco na íntegra.

### 1.2 `buildIndex` e `readIndex` (`src/ecosystem.mjs:865-904`)
- `buildIndex`:
  - Itera sobre todos os arquivos canônicos e de projeto.
  - Para cada arquivo, lê novamente o corpo (`readFileSync(file, 'utf8')`), analisa frontmatter, executa regex de detecção de segredos (`SECRET_RE`), fatiamento em seções (`privacySections`), extração de links, tags e claims.
  - Possui um suporte parcial a `changed=true` (linhas 867-879), aproveitando entradas anteriores se `oldEntry.modified_ms === modified && oldEntry.source_text_hash === hash(text)`. Porém, como precisa de `hash(text)` para comparar, o corpo já foi lido do disco!
  - Serializa o índice completo em `.holoself/index/index.json` via `atomicWrite` (`JSON.stringify(index, null, 2)`).
- `readIndex`:
  - Se `index.json` não existir, estiver corrompido ou `!freshness.fresh`, dispara `buildIndex`.
  - Como `freshness.fresh` lê todos os arquivos, `readIndex` sempre causa varredura integral de corpos.

### 1.3 `sourceRecords` e `contextData` (`src/ecosystem.mjs:372-402, 565-567`)
O caminho de contexto principal (`holoself context` e ferramenta MCP `contextData`) **não utiliza `readIndex` nem o índice persistente**:
```javascript
// ecosystem.mjs:565-567
const selfData = sourceRecords(self, 'self', lens, o.task, adapter, link, registry, resolution, o, identity.kind);
const local = !o.selfOnly && existsSync(project) && resolve(project) !== resolve(self)
  ? sourceRecords(project, 'project', lens, o.task, adapter, link, registry, resolution, o, identity.kind)
  : {records: [], restrictions: [], warnings: []};
const candidates = [...selfData.records, ...local.records, ...(o.task ? contribRecords(self, lens, resolution) : [])];
```
- Em `sourceRecords`:
  - Lista todos os arquivos (`canonicalFiles` ou `projectMarkdownFiles`).
  - Executa imediatamente `const text = readFileSync(path, 'utf8')` para cada arquivo.
  - Faz `frontmatter(text)`, filtro de visibilidade, redação de claims/fields, e monta um array de objetos em memória contendo o corpo integral filtrado (`filteredBody`).
- **Problema diagnosticado (E-01):**
  Toda e qualquer invocação de `contextData`, seja ela:
  1. Uma consulta repetida idêntica com cache quente;
  2. Uma solicitação de manifesto (`manifest: true`), que descarta todos os corpos e retorna `content: ''`;
  3. Uma expansão de um único handle específico (`sources: ['hs-xxx']`);
  lê **todos os arquivos Markdown do disco** antes mesmo de chamar o seletor ou verificar o cache!

### 1.4 Seleção e Caches (`src/context-selection.mjs:163-175`)
```javascript
const CACHE = new Map();
function cacheKey(records, options={}) {
  const state = records.map(record => [sourceId(record), record.source_hash, record.content.length]);
  return hash(JSON.stringify({state, task: options.task||'', lens: options.lens||'', ...}));
}
export function persistentSelection(records, options={}, cacheDir) {
  if (!cacheDir) return cachedSelection(records, options);
  const key = cacheKey(records, options), path = join(cacheDir, `${key}.json`);
  if (existsSync(path)) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value?.receipt?.context_hash) return {...value, cache: {key, hit: true, persistent: true}};
    } catch {}
  }
  const value = selectContextRecords(records, options), stored = {...value};
  ...
}
```
- O cache persistente grava em `.holoself/cache/${key}.json`.
- Porém, o argumento `records` recebido por `persistentSelection` já é a lista de todos os registros carregados por `sourceRecords`!
- O cache hit ocorre no seletor, mas o I/O de disco de leitura dos corpos já aconteceu previamente.
- Além disso, o cache em disco não possui mecanismo de evicção (LRU, TTL ou limite de armazenamento), violando R-07 e gerando crescimento descontrolado (apontado pelo Claude Code em 4.1).

---

## 2. Comparativo de Armazenamento Local: JSON vs. SQLite (Decisão D-02)

O ciclo C-02 exige avaliar o backend de persistência para o catálogo derivado.

| Critério | Opção 1: SQLite Nativo (`node:sqlite`) | Opção 2: SQLite Externo (`better-sqlite3`) | Opção 3: Catálogo Determinístico JSON Particionado |
|---|---|---|---|
| **Suporte de Runtime** | Introduzido no Node.js v22.5.0 experimental. **Incompatível com Node 20** (`engines: {"node": ">=20"}`). | Exige dependência compilada em C++ (node-gyp / prebuilds). Falhas comuns no Windows. | **100% nativo em Node.js >= 20**. Zero dependências externas (`node:fs`, `node:crypto`). |
| **Integridade de Pacote e Auditoria** | Quebra o requisito de compatibilidade declarado no `package.json`. | Viola a política de zero dependências externas e o script `package-audit.mjs`. | Em total conformidade com a auditoria de dependências limpas e portabilidade multiplataforma. |
| **Atomicidade de Escrita (I-08)** | Transações ACID nativas e WAL mode. | Transações ACID nativas e WAL mode. | Escrita atômica em arquivo temporário único por processo (`.tmp-${pid}-${timestamp}`) + `renameSync`. |
| **Custo de Invalidação Incremental** | `UPDATE sources SET ... WHERE id = ?` em microsegundos. | `UPDATE sources SET ... WHERE id = ?` em microsegundos. | Atualização em memória do mapa de fontes + `atomicWrite` do catálogo leve (`catalog.json`). |
| **Desempenho em Escala (N=10.000)** | Leitura de índices B-Tree em < 2 ms sem carregar banco inteiro em memória. | Leitura de índices B-Tree em < 2 ms. | Catálogo de metadados compactos (sem corpos): ~2,5 MB de JSON. Parse JSON no V8 leva ~12-18 ms. Leitura sob demanda de corpos individuais. |
| **Descarte e Reconstrução (I-01)** | Requer `rm -f catalog.db*` ou `VACUUM`. Formato binário opaco. | Requer `rm -f catalog.db*`. Formato binário opaco. | Remoção trivial de arquivo JSON; completamente inspecionável e descartável pelo usuário. |

### Conclusão e Recomendação D-02:
Adotar a **Opção 3 (Catálogo Determinístico JSON Estruturado e Particionado)** como backend primário do Holoself:
1. Respeita o contrato estrito de compatibilidade com Node.js `>= 20` e o princípio de zero dependências de terceiros.
2. Separa rigorosamente os **metadados/política/sumários** dos **corpos brutos**:
   - `catalog.json` armazena exclusivamente: `source_id`, `path`, `source_kind`, `mtimeMs`, `size`, `source_text_hash`, metadados de privacidade, seções (títulos e visibilidade), claims e tags. Não armazena o texto completo de documentos longos.
   - Para $N=100$, `catalog.json` tem ~35 KB.
   - Para $N=1.000$, `catalog.json` tem ~350 KB.
   - Para $N=10.000$, `catalog.json` tem ~3,5 MB (parseado em menos de 20 ms no Node.js).
3. Os corpos brutos só são lidos diretamente do Markdown original sob demanda para as $k$ fontes selecionadas pelo algoritmo de ranking.

---

## 3. Modelo de Frescor, Invalidação e Análise da Decisão D-08

### 3.1 O Dilema D-08: Frescor vs. Zero Releituras
- **Opção (a) [V-01 Estrito]:**
  - Na consulta repetida em catálogo válido, **zero arquivos Markdown são abertos ou lidos** (`bodyReads = 0`).
  - O frescor é verificado via `statSync(file)` checando `mtimeMs` e `size` contra os valores registrados no catálogo.
  - Se nenhum arquivo teve `mtimeMs` ou `size` alterado, o catálogo é considerado válido e nenhum corpo é lido.
  - *Modelo de Ameaça e Limitações:*
    - Uma edição que preserve exatamente o mesmo tamanho e o mesmo timestamp `mtimeMs` (ou adulteração deliberada via `utimesSync`) não seria detectada sem reler o corpo.
    - O contrato T00-S explicitou que "mtime/tamanho isolados não bastam se o modelo de ameaça incluir bypass de stat". No entanto, em sistemas operacionais normais, qualquer editor ou processo que modifique o arquivo altera `mtime` ou `size`.
- **Opção (b) [Verificação de Entrega]:**
  - Na consulta repetida, os candidatos são selecionados a partir do catálogo sem ler nenhum corpo dos candidatos descartados.
  - Para as $k$ fontes **efetivamente selecionadas para entrega**, o sistema lê seus corpos do Markdown e calcula `sha256(body)` para validar que correspondem exatamente a `source_text_hash` do catálogo antes de retornar ao agente.
  - Fontes descartadas não são lidas ($100 - k$ leituras economizadas).
  - Em um manifesto ($k=0$ corpos entregues), são realizadas **0 releituras de corpo** em ambas as opções!

### 3.2 Comparativo Quantitativo Previsto

| Operação (N=100) | Baseline C-00 (Atual) | Com Catálogo Incremental [Opção a] | Com Catálogo Incremental [Opção b] |
|---|---|---|---|
| **CLI context cold** | 100 body reads | 100 body reads (população inicial do catálogo) | 100 body reads |
| **CLI context warm (repetido)** | 100 body reads | **0 body reads** (V-01 estrito satisfeito) | **k body reads** (ex: 2 a 5 arquivos selecionados) |
| **Manifest warm** | 100 body reads | **0 body reads** (V-02 satisfeito) | **0 body reads** (V-02 satisfeito) |
| **Expansão de 1 fonte** | 100 body reads | **1 body read** (V-02 satisfeito) | **1 body read** (V-02 satisfeito) |
| **Search com índice pronto** | 100 body reads | **0 body reads** (E-02 resolvido) | **0 body reads** (E-02 resolvido) |

### 3.3 Recomendação Técnica para D-08 / T02-S:
Apresentar a análise a Claude Opus em T02-V demonstrando que:
1. **Manifesto quente e Busca quente** atingem rigorosamente **0 body reads** em ambas as opções.
2. Para **Consulta repetida (V-01)**:
   - Se o usuário e Claude Opus optarem por manter V-01 estrito (Opção a), o Holoself atinge 0 body reads baseando a invalidação em `statSync` (mtime + size + verificação de existência/remoção de arquivos).
   - Se for exigida proteção criptográfica contra alteração de corpo que preserve mtime/size em arquivos entregues (Opção b), isso constitui alteração de aceite que deve ser aprovada explicitamente pelo usuário.
   - O design do catálogo deve suportar ambos os modos via configuração (`verification: 'stat' | 'delivery-hash'`).

---

## 4. Concorrência, Escrita Atômica e Evicção de Cache (R-07, V-07, V-11)

### 4.1 Escrita Atômica e Crash Recovery (I-08, V-07)
- Todas as gravações no catálogo (`catalog.json`) e nos arquivos de cache persistente usam o padrão:
  1. Criação do arquivo temporário com identificador exclusivo de processo e timestamp: `${target}.tmp-${process.pid}-${Date.now()}`.
  2. Gravação completa síncrona com flush.
  3. `renameSync(tempFile, target)`.
- Se o processo falhar durante a escrita, o arquivo original permanece íntegro e legível. Arquivos temporários residuais são limpos na inicialização.
- Se dois processos tentarem reconstruir o catálogo simultaneamente, ambos produzem estados determinísticos equivalentes a partir da mesma fonte Markdown canônica; o último `renameSync` conclui atomicamente sem corromper o JSON.

### 4.2 Limite de Armazenamento e Evicção de Cache (R-07, V-11, D-06)
- O diretório `.holoself/cache/` atual armazena arquivos `${key}.json` indefinidamente.
- Proposta de governança de cache para C-02:
  - **Teto configurável de entradas e bytes:** Máximo padrão de 256 arquivos de cache ou 20 MiB totais.
  - **LRU baseado em `mtime`:** Quando o número de arquivos ou tamanho ultrapassa o teto, o seletor remove os arquivos com `atime`/`mtime` mais antigos.
  - **Invalidação por política e registro:** Toda chave de cache vincula-se a `lens_registry_hash` e ao `policy_hash`. Se a política ou o registro de lentes mudar, o cache anterior é automaticamente ignorado e expurgado.
  - **Expiração temporal (R-07):** Detecção de `valid_until` em fontes selecionadas; o cache registra o menor `valid_until` entre as fontes contidas e expira automaticamente se o relógio ultrapassar esse limite, mesmo sem alteração física no arquivo.

---

## 5. Próximos Passos Imediatos
1. Submeter este mapeamento e análise técnica como entrega de **T02-R**.
2. Proceder para **T02-S**: elaboração do contrato formal `C02-CONTRACT-1` detalhando os schemas de catálogo, as assinaturas de API incremental, e a formulação da proposta de decisão D-08.
3. Submeter `C02-CONTRACT-1` e D-08 à revisão adversarial de Claude Opus (**T02-V**).
