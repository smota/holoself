# Relatório Comparativo Antes/Depois: Linha de Base C-00 vs. Estado Integrado C-06

Este relatório documenta a evolução quantitativa, arquitetural e de segurança do Holoself desde a caracterização empírica inicial (**C-00**) até a prontidão técnica integrada (**C-06**), conforme a especificação `context-and-lenses-vnext`.

---

## 1. Síntese Executiva

| Métrica / Invariante | Linha de Base Inicial (C-00) | Estado Integrado (C-06) | Impacto / Ganho |
|---|---|---|---|
| **E-01: Vazamento de Corpos no Manifesto** | Reproduzido (`true`): leitura antecipada de todos os corpos | **Resolvido (`false`)**: Zero-I/O em corpos (`estimatedTokensBody: 0`) | Elimina overhead de I/O em listagens e previne vazamento de dados confidenciais. |
| **E-02: Over-read na Expansão** | Reproduzido (`true`): leitura de documentos não solicitados | **Resolvido (`false`)**: leitura estritamente restrita aos `source_ids` | Isolamento estrito na expansão dirigida de handles. |
| **E-03: Estouro de Limites de Envelope** | Reproduzido (`true`): payloads sem teto com estouro de contexto | **Resolvido (`false`)**: tetos rígidos D-06 (16 KiB, 48 KiB, 128 KiB) | Estabilidade garantida para LLMs com janelas de contexto limitadas. |
| **E-04: Leitura de Cache Obsoleto** | Reproduzido (`true`): falhas na detecção de alterações same-size mtime | **Resolvido (`false`)**: SHA-256 de conteúdo e invalidação em delete/rename | Consistência e integridade absoluta na entrega de contexto warm. |
| **E-05: Revogação Ignorada** | Reproduzido (`true`): dados revogados permaneciam servidos via cache | **Resolvido (`false`)**: `links_register_hash` e invalidação imediata | Revogação de acesso instantânea sem janelas de tolerância. |
| **E-06: Escalação de Privilégios Multi-Espaço** | Reproduzido (`true`): oráculos de temporização e vazamento de fontes pares | **Resolvido (`false`)**: interseção tripla, anti-oráculo V-06 e Zero-I/O | Isolamento soberano e privacidade estrita entre repositórios pares. |
| **E-07: Vazamento de Corpos em Tarefas Mecânicas** | Reproduzido (`true`): corpos pessoais lidos e entregues em formatação/lint | **Resolvido (`false`)**: 0 caracteres e 0 leituras de corpo (`personalBodyChars: 0`) | Proteção total de privacidade para tarefas mecânicas e código puro. |
| **E-08: Acesso Não Validado por Lente Customizada** | Reproduzido (`true`): herança cega de base built-in sem checagem de grant | **Resolvido (`false`)**: validação formal contra bases e sensitivity grants | Rejeição estrita fail-closed para documentos restritos e confidenciais. |
| **Casos de Qualidade PT/EN (36 casos)** | Falhas em 100% dos casos mecânicos (vazamento de corpos) | **36 de 36 aprovados (100% de sucesso)** | Paridade multilíngue e atendimento perfeito a tarefas pessoais, mecânicas e ambíguas. |
| **Suíte de Testes Automatizados** | 133 testes | **222 testes (100% de aprovação)** | Cobertura ponta a ponta sem dependências externas. |

---

## 2. Detalhamento das Melhorias por Vetor

### 2.1 Eficiência de I/O e Descoberta (V-01, V-02)
- **Antes:** Cada consulta de contexto ou pedido de manifesto percorria todo o repositório, lia o conteúdo de todos os arquivos Markdown para a memória e gerava fingerprints volumosos.
- **Depois:** O catálogo particionado (`catalog.json`) armazena hashes SHA-256 e metadados de acesso estruturados. A geração de manifestos (`holoself context --manifest` ou `holoself_context_manifest`) realiza **Zero-I/O** em arquivos de corpo. Na entrega de contexto com cache (*warm delivery*), somente os arquivos efetivamente selecionados dentro do orçamento são lidos do disco (`selectedBodyReads <= 10`, `nonselectedBodyReads === 0`).

### 2.2 Controle de Envelope e Truncamento (V-03, D-06)
- **Antes:** O tamanho da saída em bytes não era monitorado, permitindo que consultas em repositórios médios excedessem centenas de kilobytes, sobrecarregando ferramentas e provedores de IA.
- **Depois:** Medição estrita de bytes UTF-8 serializados (`Buffer.byteLength`). Limites fixados em 16 KiB (`small`), 48 KiB (`standard`) e 128 KiB (`deep`). Truncamento gracioso baseado em pontuação de relevância (`task_relevance`), preservando a validade sintática do envelope e metadados de recibo.

### 2.3 Soberania de Lentes e Privacidade Multi-Espaço (V-04, V-06, V-07)
- **Antes:** Lentes personalizadas herdavam o escopo de leitura de suas lentes base, permitindo que um usuário criasse uma lente auxiliar e acessasse documentos confidenciais ou restritos. Repositórios federados vazavam a existência de arquivos restritos através de listas de omissão.
- **Depois:** Lentes customizadas recebem apenas os direitos expressamente declarados em `sensitivity_access`, sem qualquer herança implícita de escopo de leitura da base built-in. Na federação multi-espaço, aplica-se a **interseção tripla de permissões** ($L \in L_{\text{consumer}} \cap L_{\text{producer}} \cap \text{access\_lenses}(d)$), descartando silenciosamente documentos não autorizados sem vazar nomes de arquivos, handles ou tempos de resposta diferenciados.

### 2.4 Experiência de Consulta Única e Gate Mecânico (R-05, V-09)
- **Antes:** Os adaptadores MCP e CLI exigiam múltiplos passos e round-trips manuais (`manifest` $\rightarrow$ seleção de handles $\rightarrow$ `get`), ou liam indiscriminadamente dados pessoais do usuário em tarefas puramente mecânicas de programação (ex: "formatar JSON" ou "renomear variável").
- **Depois:** Introduzida a ferramenta MCP `holoself_context` e o comando unificado `holoself context --task "<tarefa>"`, fornecendo contexto completo em um único round-trip. O oráculo bilíngue `contextNeed` identifica tarefas mecânicas em português e inglês e inibe deterministicamente a leitura de corpos pessoais, garantindo `personalBodyChars === 0` e `personalBodyReads === 0`. Tarefas ambíguas preservam contexto sob a classificação `helpful` sem descartes silenciosos.

### 2.5 Migração Segura e Reversível de Políticas (V-10)
- **Antes:** Não havia mecanismo de transição entre metadados legados (`visibility`) e a nova política `access_lenses`. Edições manuais podiam causar perda de privacidade ou quebra de sintaxe.
- **Depois:** Subcomando `holoself migrate policy` com fluxo completo: `--dry-run` para pré-visualização, `--apply` com checagem de estreitamento de acesso (`--confirm-narrowing`), escrita atômica contra falhas de sistema (`atomicWriteFile`) e selo de integridade no recibo (`applied_entries_digest`). A reversão via `--revert <receipt>` restaura o estado anterior byte a byte.
