# C-05: Pesquisa e Inventário de Experiência e Integração — Consulta Única, Instruções e Workbench

| Campo | Valor |
|---|---|
| Ciclo | C-05 — Experiência e integração |
| Tarefa | T05-R |
| Responsável | Agente (A) |
| Data | 2026-09-21 |
| Status | Concluído — pronto para T05-S (C05-CONTRACT-1) |
| Rastreabilidade | R-05, R-10; A-04, A-05, A-06; V-03, V-04, V-09; D-05, D-06; J-1, J-2, J-3 |

---

## 1. Contexto e Objetivos da Pesquisa

O Ciclo C-04 consolidou a federação real soberana entre múltiplos espaços registrados (`links.json`), isolamento anti-oráculo estrito (V-06), deduplicação pós-autorização e resiliência com rebaixamento transparente para `status: "partial"`.

O Ciclo C-05 tem por finalidade unificar e refinar a experiência do agente e do usuário em três frentes complementares:
1. **Consulta Única Orientada à Tarefa (R-05, A-04, A-05):** Viabilizar que o agente receba contexto rico, relevante e delimitado em uma única chamada (`holoself context --task "<request>"` na CLI e ferramenta direta em MCP), sem exigir fluxo preliminar obrigatório de manifesto seguido de expansão. Manifesto e expansão pontual permanecem disponíveis como capacidades opcionais de aprofundamento.
2. **Gate Determinístico de Necessidade e Qualidade (V-09):** Garantir que tarefas mecânicas explícitas (`format`, `rename`, `syntax`, `sort`, `convert`, `indent` e equivalentes em português) sejam confirmadas como `not-needed`, resultando em zero leituras de arquivos de corpos pessoais (`personalBodyReads === 0`) e zero caracteres pessoais entregues (`personalBodyChars === 0`). Simultaneamente, assegurar que tarefas pessoais (identidade, carreira, liderança, voz, preferências, entrevistas) entreguem evidências necessárias, e que tarefas ambíguas preservem contexto útil (`helpful`) sem descarte silencioso nem escalada indevida de privilégios.
3. **Instruções Curtas e Skill Não-Redundante (R-10):** Encurtar blocos gerenciados (`BOOTSTRAP.md`, `AGENTS.md`, adapters) e a documentação pública da skill (`SKILL.md`), removendo duplicação de regras de política em prosa que pertencem estritamente ao runtime de autorização.
4. **Compatibilidade Legada Não-Silenciosa (D-05):** Caracterizar e diagnosticar os três modos de coexistência (`link.yaml`, `context-packet.md` snapshot e filesystem junction/mount legado) sem jamais inspecionar ou ler o conteúdo de montagens reais via travessia do filesystem.
5. **Workbench Explicável e Paridade de Interfaces (A-06, V-04):** Apresentar perspectiva ativa (lente), escopo efetivo e diagnósticos seguros sem expor a existência, caminhos, títulos ou trechos de fontes negadas (preservando o isolamento anti-oráculo V-06 e V-12).

---

## 2. Inventário de Superfícies de Entrada e Instruções

### 2.1 Geração de Instruções (`src/instructions.mjs`)

O módulo `src/instructions.mjs` gera os blocos gerenciados e realiza a auditoria de integridade (`auditInstructions`):
- `bootstrapText(link)`: Gera o arquivo `.holoself/BOOTSTRAP.md`.
  - Formato atual: 4 linhas de prosa orientando a execução de `holoself context --project . --task "<current request>" --budget standard --json`, indicando a lente padrão e enumerando 3 invariantes de confiança (`TRUST_INVARIANTS`).
- `canonicalSection()`: Gera o bloco delimitado por comentários (`<!-- holoself-link-start schema=1 -->`) injetado em arquivos mestres de instruções do projeto (ex.: `AGENTS.md`).
- `overlaySection(canonical)`: Gera a variante compacta para arquivos de instruções adicionais (ex.: `CLAUDE.md`, `CODEX.md`), apontando para o arquivo canônico e para o bootstrap.
- `auditInstructions(project, link, runtime)`: Compara os hashes SHA-256 do bootstrap e do bloco gerenciado contra a evidência canônica registrada no runtime, emitindo diagnósticos explícitos (`BOOTSTRAP_DRIFT`, `CANONICAL_BLOCK_DRIFT`, etc.).

**Avaliação Crítica:**
O design de `src/instructions.mjs` já é compacto e modular. A oportunidade de refino reside em:
1. Alinhar a instrução de entrada para reforçar a chamada orientada à tarefa de round-trip único como padrão primário.
2. Evitar que novas políticas de autorização ou regras de lentes precisem ser descritas em prosa nos arquivos do projeto; a autorização reside no runtime (`contextData`), garantindo conformidade com R-10.

### 2.2 Skill Pública (`skills/holoself/SKILL.md`)

O arquivo `skills/holoself/SKILL.md` (111 linhas) é a especificação pública instalada em hosts de IA (`~/.agents/skills/holoself`, `~/.claude/...`, etc.).
Ele documenta:
1. Resolução de contexto e precedência de raízes (Data root direto > Projeto `.holoself/` > `HOLOSELF_HOME` > `~/.holoself`).
2. Três modos de projeto: Metadata Link (`link.yaml`), Exported Packet/Snapshot (`context-packet.md`), Legacy Live Mount (symlink/junction).
3. Validação de raiz canônica e layout obrigatório (`profile/`, `context/`).
4. Interface ativada (CLI `holoself context`, comandos MCP).
5. Workbench opcional e salvaguardas de escrita.
6. Políticas de segurança (sensibilidade, não-inferência, não-publicação sem aprovação humana).

**Avaliação Crítica:**
- Em conformidade com R-10, a skill não deve tentar ensinar o modelo a atuar como um motor manual de autorização nem simular filtros de regex/lentes em memória quando a CLI ou MCP estiverem presentes.
- O gatilho de ativação deve ser explícito: tarefas que tocam a continuidade pessoal, voz, carreira, histórico ou decisões do usuário ativam a consulta; tarefas puramente mecânicas de código/dados (formatação, linting, compilação, sintaxe) não devem acionar o carregamento pessoal.

### 2.3 Registro e Detecção de Adaptadores (`src/adapters.mjs`)

O módulo gerencia 10 plataformas cadastradas no `REGISTRY`:
`agents`, `claude`, `codex`, `pi`, `agy`, `antigravity`, `gemini`, `copilot`, `cursor`, `windsurf`.
- A injeção é protegida contra path traversal (`safeProjectFile`).
- O plano de ativação (`activationPlan`) distingue adaptadores com evidência detectada (`detected: true`) daqueles ausentes.
- `skills` gerenciadas suportam escopo de projeto ou global do usuário (`skillHome`).

---

## 3. Caracterização de Modos de Projeto e Compatibilidade Legada (D-05)

A convivência entre instalações modernas e projetos legados exige distinção rigorosa sem conversão automática implícita.

### 3.1 Os Três Modos de Projeto

| Modo | Assinatura Filesystem | Semântica de Leitura | Semântica de Escrita | Risco e Tratamento |
|---|---|---|---|---|
| **1. Metadata Link** | Diretório `.holoself/` real contendo `link.yaml` válido | Leitura dinâmica governada por lente e tarefa via CLI/MCP | Propostas locais (`proposals/pending`); escrita canônica exige aprovação explícita | Modo padrão recomendado. Seguro e delimitado. |
| **2. Snapshot Exportado** | Diretório `.holoself/` real contendo `context-packet.md` (ou em `runtime/`) sem `link.yaml` | Leitura estática autotida; dados pré-computados com prazo de expiração | Não permite propostas automáticas; edições manuais | Somente leitura de contingência. Não sincroniza alterações. Diagnosticado como `manual-only`. |
| **3. Live Mount Legado** | Entrada `.holoself` como symlink ou junction de filesystem apontando para uma raiz de dados | Exposição completa da árvore de dados aos executáveis do projeto | Escrita direta no filesystem pelo projeto | **Alto risco.** Expõe dados privados brutos sem barreira de lentes. Manter isolado; não converter silenciosamente. |

### 3.2 Princípio Inviolável de Não-Leitura de Mounts Reais

Em conformidade com D-05 e as diretrizes de segurança:
1. **Zero-I/O em Junções:** O diagnóstico de um projeto com junção legada `.holoself` deve utilizar estritamente `lstatSync(path).isSymbolicLink()`.
2. **Proibição de Travessia:** O sistema não deve executar `readdirSync`, `readFileSync` ou buscas indexadas através da junção legada sem comando afirmativo do usuário.
3. **Diagnóstico Explícito:** `holoself link status` e `holoself doctor` devem rotular o modo claramente como `legacy-mount`, indicando que ferramentas do projeto têm acesso direto sem filtro de lentes, recomendando migração para `link.yaml` via `holoself link setup`.
4. **Remoção Segura:** A desvinculação (`holoself unlink --target <dir>`) deve remover unicamente a junção de ponteiro sem tocar na raiz de dados original apontada.

---

## 4. Consulta Única Orientada à Tarefa vs Fluxo em Múltiplas Etapas (R-05)

### 4.1 Limitação do Fluxo Atual de MCP

Na implementação de `src/mcp-server.mjs`:
- O servidor expõe as ferramentas:
  - `holoself_context_manifest`: Retorna metadados e handles das fontes sem corpo (`estimatedTokensBody: 0`).
  - `holoself_context_get`: Exige que o cliente forneça uma lista explícita de `source_ids` (`minItems: 1, maxItems: 16`) para resolver os corpos autorizados.
- **Problema de Integração:** Qualquer agente utilizando MCP é obrigado a realizar no mínimo **duas viagens de ida e volta (round-trips)**:
  1. Chamar `holoself_context_manifest` com a tarefa.
  2. Inspecionar a lista de handles retornados e chamar `holoself_context_get`.
- Isso viola a expectativa de R-05 ("Oferecer uma consulta orientada à tarefa que normalmente entregue contexto útil em uma chamada").

### 4.2 Arquitetura da Consulta Única (R-05)

Para atender a R-05 mantendo total paridade:
1. **CLI:** Já suporta `holoself context --task "<text>"`, entregando o payload com documentos preenchidos quando `manifest` não for solicitado.
2. **MCP:** Deve oferecer uma ferramenta de consulta única orientada à tarefa (`holoself_context`), que aceita `{ task, lens, budget, temporal }` e executa a seleção e entrega de corpos em uma única chamada.
3. **Expansão Opcional Preservada:** As ferramentas `holoself_context_manifest` e `holoself_context_get` continuam operacionais para clientes que deliberadamente optem por inspecionar metadados antes de buscar corpos volumosos.
4. **Tratamento de `not-needed`:** Quando o gate de necessidade classificar a tarefa como `not-needed`, a consulta única retorna status `not-needed` com lista de documentos de corpos pessoais vazia (`documents: []`), sem falhar e sem carregar conteúdo desnecessário.

---

## 5. Análise do Gate de Necessidade e Relevância Determinística (V-09)

### 5.1 O Conjunto Congelado de 36 Casos de Teste (C-00)

O harness de teste em `tests/helpers/c00-fixture.mjs` define exatamente 36 tarefas congeladas divididas em duas línguas e três classes:
- **Inglês (EN):** 6 pessoais, 6 mecânicas, 6 ambíguas (18 casos).
- **Português (PT):** 6 pessoais, 6 mecânicas, 6 ambíguas (18 casos).

### 5.2 Diagnóstico das 18 Falhas na Baseline Atual

A execução de `scripts/c00-baseline.mjs` revelou que atualmente **apenas 18 dos 36 casos passam** (50% de falha em V-09). A análise detalhada identificou as causas raízes exatas:

```text
Failed count: 18
q-en-mechanical-1 mechanical en needMatches: true, got need: not-needed (bodyReads: 51, bodyChars: 5368) -> FALHOU POR I/O
q-en-mechanical-2 mechanical en needMatches: true, got need: not-needed (bodyReads: 51, bodyChars: 5368) -> FALHOU POR I/O
q-en-mechanical-3 mechanical en needMatches: true, got need: not-needed (bodyReads: 51, bodyChars: 5368) -> FALHOU POR I/O
q-en-mechanical-4 mechanical en needMatches: false, got need: helpful (task: "Sort these three integers: 3, 1, 2")
q-en-mechanical-5 mechanical en needMatches: false, got need: helpful (task: "Convert this literal timestamp to ISO notation")
q-en-mechanical-6 mechanical en needMatches: false, got need: helpful (task: "Indent this supplied CSS rule")
q-pt-personal-1..6   personal   pt needMatches: false, got need: helpful (classificação pessoal não detectou PT)
q-pt-mechanical-1..6 mechanical pt needMatches: false, got need: helpful (classificação mecânica não detectou PT)
```

As três causas raízes são:
1. **Leitura Indevida de Corpos em `not-needed`:**
   - Em `src/ecosystem.mjs:1273-1308`, mesmo quando `contextNeed(o.task) === 'not-needed'`, o laço de entrega invoca `deliverRecord(cand)` para todos os candidatos selecionados, efetuando 51 leituras de corpos de arquivos (`personalBodyReads = 51`) e retornando 5.368 caracteres de corpos pessoais (`personalBodyChars = 5368`).
   - O critério V-09 exige rigorosamente:
     `const mechanicalEmpty = item.class !== 'mechanical' || (sample.io.bodyReads === 0 && personalBodyChars === 0);`
   - **Correção:** Quando `contextNeed === 'not-needed'` (e o chamador não tiver solicitado fontes explícitas via `--source`), a seleção de candidatos `self` deve omitir a entrega de corpos pessoais, resultando em `personalBodyReads === 0` e `personalBodyChars === 0`.
2. **Vocabulário Mecânico Incompleto em EN e Ausente em PT:**
   - A função `contextNeed` em `src/context-selection.mjs:17` continha apenas:
     `['format','rename','compile','lint','test','syntax','install']`.
   - Faltavam verbos mecânicos de computação em inglês: `sort`, `convert`, `indent`.
   - Faltavam todas as raízes/verbos correspondentes em português: `formate`, `renomeie`, `compile`, `teste`, `sintaxe`, `instale`, `ordene`, `converta`, `indente`, `corrija`.
3. **Vocabulário Pessoal Ausente em PT:**
   - A função `contextNeed` possuía apenas termos em inglês: `['identity','career','leadership','voice','preference','personal','interview','application','holoself']`.
   - Em português, tarefas contendo `identidade`, `carreira`, `liderança`/`lideranca`, `voz`, `preferência`/`preferencia`, `pessoal`, `entrevista`, `apresentação`/`apresentacao`, `prioridades` retornavam erroneamente o fallback `helpful` em vez de `required`.

### 5.3 Comportamento de Tarefas Ambíguas

- As 12 tarefas ambíguas (6 EN e 6 PT, ex.: "Compare these options for my next step", "Melhore este rascunho para a conversa") retornam `helpful`.
- Em conformidade com R-05 e V-09:
  - Contexto relevante é selecionado e entregue respeitando o orçamento configurado.
  - Não há descarte silencioso de contexto.
  - Não há escalada de privilégios (acesso restrito continua estritamente barrado pela política).
  - Todos os 12 casos ambíguos passam com sucesso.

---

## 6. Orçamentos de Envelope e Truncamento Gradual (V-03, D-06)

### 6.1 Limites de Envelope Congelados em C-00

Os limites de bytes de saída serializada UTF-8 exposta ao agente estão formalmente fixados em:
- `small`: 16.384 bytes (16 KiB).
- `standard`: 49.152 bytes (48 KiB).
- `deep`: 131.072 bytes (128 KiB).

### 6.2 Princípios de Truncamento

1. O limite de envelope cobre o payload completo entregue (corpos de texto, metadados, restrições, validações, recibo e wrappers de transporte MCP).
2. O truncamento gradual ocorre removendo ordenadamente os trechos/fontes de menor relevância pontuada (`task_relevance`), preservando documentos canônicos de maior valor e mantendo o envelope estritamente abaixo do teto de bytes.
3. Fontes obrigatórias (`requiredMarkers`) de tarefas pessoais devem caber no perfil `deep` sem sofrer truncamento de seus marcadores essenciais.

---

## 7. Workbench: Explicabilidade, Escopo e Isolamento Anti-Oráculo (A-06, V-04)

### 7.1 Superfície Atual do Workbench

O servidor HTTP local (`src/web-server.mjs`) e a aplicação SPA (`web/app.mjs`):
- O endpoint `/api/spaces/:id/context` executa `context --project <path> --budget small --manifest --json`.
- A SPA exibe a perspectiva ativa (lente padrão do link), estado de ativação e propostas pendentes.

### 7.2 Requisitos de Explicabilidade Segura (A-06, V-04, V-06)

1. **Exibição Clara da Perspectiva e Escopo:**
   - O Workbench deve explicitar a lente ativa, o número de documentos acessíveis na lente e os escopos incluídos/excluídos definidos no link.
2. **Diagnósticos Seguros sem Oracle Leakage:**
   - Documentos restritos de espaços pares (federados) não devem aparecer em contagens de restrição, listas de arquivos ou mensagens de erro.
   - Omissões devem ser explicadas por categorias neutras ("context budget exhausted", "excluded by temporal selector", "policy restricted"), sem revelar caminhos ou nomes de arquivos não autorizados ao cliente do projeto.
3. **Diagnóstico dos Modos D-05:**
   - O status do espaço deve apresentar distintamente se o projeto está vinculado via `metadata-link`, se opera sobre `snapshot-only` ou se apresenta colisão com `legacy-mount`, permitindo que o usuário identifique a topologia sem precisar inspecionar manualmente a tabela de inodes do sistema operacional.

---

## 8. Matriz de Requisitos, Decisões e Conclusão de T05-R

| Requisito / Decisão | Situação na Baseline | Solução Prescrita para C05-CONTRACT-1 |
|---|---|---|
| **R-05** Consulta única útil | CLI suporta; MCP força 2 chamadas obrigatórias (manifest + get) | Introduzir ferramenta MCP direta orientada à tarefa (`holoself_context`); preservar manifest/get como capacidades opcionais |
| **V-09** Qualidade PT/EN | 18/36 casos falhando por vocabulário faltante e I/O de corpos em `not-needed` | Expandir dicionário determinístico de `contextNeed` para termos PT/EN; suprimir leitura e corpos de `self` quando `not-needed` |
| **R-10** Instruções curtas | Textos adequados, mas sem formalização clara da entrada única | Consolidar instrução de consulta única em `BOOTSTRAP.md` e `SKILL.md` sem prosa redundante de controle de acesso |
| **D-05** Compatibilidade legada | Tratamento disperso entre CLI e status | Formalizar oráculo de detecção de modos (link / snapshot / mount) com Zero-I/O em mounts reais |
| **D-06** Tetos de envelope | Tetos 16k/48k/128k aprovados em V-03 | Reafirmar tetos no contrato integrado |
| **A-06 / V-04** Workbench e paridade | Workbench exibe dados estáticos em partes | Paridade de decisão garantida por compartilhamento direto do núcleo de autorização |

Com este inventário e diagnóstico exaustivos, a tarefa **T05-R está concluída**. A próxima etapa é a formulação técnica formal do contrato **C05-CONTRACT-1** na tarefa **T05-S**.
