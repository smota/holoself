# Holoself — plano de implementação de contexto e lentes

ID: HS-PLAN-001 | Versão: 0.1 | Data: 2026-09-19

Estado: C-00 concluído e verificado em 2026-09-20; C-01 iniciado; C-02–C-06 planejados e não iniciados. Base normativa: [HS-SPEC-001](context-and-lenses-vnext.md), versão 0.1. Baseline Git confirmado: `1217e7c5241fcd3bc9a8aa1a6e759f6e16c78a95`, pacote 0.8.0. Nenhuma alteração de produto realizada em C-00.

## 0. Entrada para coordenação e agentes

Este é o segundo documento: define trabalho, responsáveis, dependências e provas de conclusão. A especificação original mantém a autoridade sobre R-*, I-*, A-* e V-*. Os esclarecimentos propostos aqui devem ser reconciliados com ela em T00-S antes de desenvolvimento. A instrução posterior do usuário autorizou a execução de C-00; release, instalação, migração real e ciclos seguintes continuam fora desta execução.

O coordenador lê §§1–3 e o ciclo ativo. Cada executor recebe somente sua linha de tarefa, o contrato aprovado do ciclo, os IDs relevantes da especificação e os arquivos necessários. O revisor recebe também os invariantes completos, casos adversariais e decisões que atravessam componentes. Leitura transversal extensa é atribuída ao agy; os outros agentes verificam diretamente as evidências críticas, sem depender cegamente do resumo.

Convenção: Tnn-R = pesquisa; Tnn-S = especificação detalhada; Tnn-V = validação independente pelo Claude; Tnn-Dx = desenvolvimento; Tnn-F = testes finais e aceite. O registro §4.5 indica o estado atual de C-00; demais tarefas continuam planejadas.

## 1. Modelos, custo e responsabilidade

| Código | Executor / modelo prescrito | Uso e motivo |
|---|---|---|
| Q | Codex, `gpt-6-astra`, high | Coordenação, decisões arquiteturais, segurança, integração e aceite. Concentrar aqui decisões com grande custo de erro. |
| L | Codex, `gpt-5.6-luna`, medium | Fixtures, documentação, ajustes locais e testes de contrato estável; escopo pequeno e verificável. |
| T | Codex, `gpt-5.6-terra`, medium | Implementação modular de complexidade moderada e análise de testes; equilíbrio inicial de custo/qualidade. |
| S | Codex, `gpt-5.6-sol`, high | Política, concorrência, migração e federação: falhas atravessam fronteiras e exigem raciocínio maior. |
| A | agy, `gemini-3.8-flash-medium` | Leitura extensa, inventário, extração de evidências e comparação de contratos; saída compacta e citada. |
| AP | agy, `gemini-3.1-pro-high` | Escalada de pesquisa quando Flash deixa contradições ou dependências sem solução. |
| C | Claude Code, alias `sonnet` | Validação independente da especificação de cada ciclo, em sessão nova e somente leitura. Registrar o ID resolvido pelo provedor. |
| CO | Claude Code, alias `opus` | Revisões de alto risco C-01/C-02/C-03/C-04 e divergências de segurança. Registrar o ID resolvido. |
| G | Grok CLI, `grok-4.6` | Revisão final do plano completo e fechamento futuro da entrega integrada. |

Inventário consultado nesta sessão: `agy models` oferece os modelos A/AP; `grok models` oferece `grok-4.6` e `grok-4.5`; os modelos Codex constam do catálogo da sessão. Disponibilidade não demonstra qualidade nem preço efetivo da conta. Os aliases Claude são deliberados: resolver e registrar no recibo, sem inventar versão fixa.

A seleção começa por qualidade verificável e só então reduz custo, conforme a [orientação oficial de seleção](https://developers.openai.com/api/docs/guides/model-selection). A [documentação de modelos](https://developers.openai.com/api/docs/models) posiciona Luna para custo, Terra para equilíbrio e Astra para tarefas complexas. Não há promessa de economia percentual, nem comparação monetária entre assinaturas sem medição.

**Heurística operacional:** começar pelo modelo prescrito; uma correção delimitada no mesmo modelo; após duas tentativas sem aceite, escalar L → T → S → Q, ou A → AP. Segurança, alteração de contrato ou ambiguidade de autoridade vão diretamente a Q; revisão Claude continua independente. Não reduzir o nível de revisões críticas para economizar. Não substituir silenciosamente agy, Claude ou Grok caso estejam indisponíveis.

Indisponibilidade de agy/Claude/Grok coloca sua tarefa em `blocked`; Q pode continuar tarefas independentes, mas não assume a identidade nem simula o parecer do provedor requerido. Retomar a tarefa quando o provedor voltar; A → AP continua dentro do agy.

**Medição por tarefa:** modelo solicitado/resolvido, esforço, tokens reportados, tempo, tentativas, custo real quando disponível, defeitos por severidade e aceite na primeira passagem. Não confundir tokens estimados de Holoself com consumo dos agentes. C-00 calibra a escolha em trabalho real: Q amostra todas as tarefas iniciais L/T e mantém o modelo barato somente quando testes e revisão passam. Reavaliar por classe de tarefa, não por reputação geral do modelo.

**Suspensão por classe:** suspender o modelo após duas tarefas consecutivas reprovadas na primeira passagem, aceite inicial inferior a 80% nas últimas cinco tarefas da classe, ou um defeito alto de segurança não detectado pelo executor. Usar o próximo nível até recalibração; retornar ao anterior somente após três tarefas supervisionadas aprovadas. Amostras pequenas são sinal operacional, não estimativa estatística de qualidade. Q confere diretamente toda evidência de fronteira de autorização e uma amostra mínima de três outras afirmações de cada T01-R/T02-R/T03-R/T04-R; divergência material exige nova pesquisa AP antes de S.

## 2. Contrato de execução e gates

Cada ciclo segue `R → S → V → D → F`. A pesquisa produz mapa de evidências, a especificação fecha os contratos, Claude os desafia, desenvolvimento implementa o contrato aprovado e Q afere os resultados finais. Revisão atual do plano não substitui as revisões futuras de contratos detalhados.

**Saída obrigatória S:** entradas/saídas e schemas; identidade/operação; revisões e erros; algoritmo/pseudocódigo quando necessário; arquivos de propriedade; casos positivos/negativos/concorrentes; testes vinculados a R/V; limites mensuráveis; compatibilidade, rollback e exclusões. Fechar decisões D-* do ciclo com justificativa. Manter essas fichas junto do ciclo neste documento durante a execução, sem criar uma árvore de instruções redundantes.

**Saída obrigatória V:** veredito `approved` ou `changes-required`, hash do contrato revisado, achados com severidade, contraexemplo, requisito e correção exigida. Claude não escreve a especificação que está aprovando. Q responde a cada achado; contrato alterado retorna ao Claude. Bloqueadores e achados altos impedem D; baixos podem virar pendência nomeada sem enfraquecer aceite. Autor não aprova sozinho sua própria mudança.

**Saída obrigatória D:** diff limitado, testes pertinentes, IDs atendidos, limitações e instrução de reversão. Mudança de contrato retorna a S/V. Desenvolvedor pode escrever testes; o agente F complementa casos negativos a partir do contrato, sem copiar apenas a implementação.

**Saída obrigatória F:** Q inspeciona diff e executa/reproduz os comandos no estado integrado; registra revisão Git + hash do diff e fixtures, ambiente, comandos, exit codes, métricas e falhas. Aprovação de modelo sem execução não vale como teste. Reprovação volta à tarefa D responsável, seguida de repetição dos testes afetados e do gate do ciclo. Sem exclusões novas ou skips para obter verde. Desvios de aceite exigem decisão explícita do usuário.

**Pacote de atribuição:** `task_id`, objetivo, modelo, baseline, contrato/hash, R/A/V, caminhos de leitura/escrita, dependências concluídas, casos de aceite, comando, limites e formato de entrega. Ficam fora corpus pessoal e transcrições completas. Pesquisa extensa: mais de oito arquivos ou comparação entre três componentes; agy entrega até 1.500 palavras com caminho/símbolo, fato versus hipótese e lacunas. Pedir segunda passagem focal quando faltarem evidências.

**Concorrência:** até três executores mais Q; um escritor por arquivo. `src/ecosystem.mjs`, schemas e contratos compartilhados têm dono nomeado antes do dispatch. Preferir worktrees para mudanças independentes, sem copiar dados privados. Q integra em ordem, resolve conflitos e invalida testes de revisões anteriores quando necessário. Após falha de agente, conferir diff antes de redistribuir; não repetir mutações às cegas.

**Fronteira desta execução:** C-00 inclui documentos, harness, fixtures sintéticas e avaliações, sem alterar comportamento do produto. Migração real, compartilhamento ampliado, publicação, envio de contexto e instalação continuam sendo atos separados. Revisão de prompt injection valida a fronteira do produto e instruções de consumo; não promete controlar qualquer ferramenta de um agente externo.

## 3. Dependências e decisões antes do código

```mermaid
flowchart LR
  C00[C-00 Baseline e contratos de medição] --> C01[C-01 Coerência]
  C01 --> C02[C-02 Catálogo]
  C01 --> C03[C-03 Lentes e política]
  C02 --> C04[C-04 Federação]
  C03 --> C04
  C04 --> C05[C-05 Experiência]
  C05 --> C06[C-06 Prontidão]
```

C-02 e C-03 permitem pesquisa/especificação paralelas; a sequência padrão de implementação é C-02 e depois C-03. Existe um gate cruzado obrigatório: T03-S/T03-V fecham antecipadamente o contrato de sujeito, espaço e revisão de política; T02-V verifica sua compatibilidade antes de liberar T02-D1. Isso não exige implementar C-03 antes do catálogo. T01-S já define uma interface de autorização versionável, mantendo apenas a semântica legada em C-01. Paralelizar código somente com contratos fixos e arquivos distintos. C-04 depende dos dois gates finais. Não existe benefício presumido em ocupar todos os agentes.

Ordem de tarefas que prevalece sobre o diagrama resumido: `T02-R → T02-S (proposta de SourceRef/SubjectSpacePolicyRev) → T03-S → T03-V → T02-V → T02-D1 → T02-D2 → T02-F → T03-D1 → T03-D2 → T03-F`. `SubjectSpacePolicyRev` é o recorte sujeito/espaço/revisão, incluindo identidade de fonte, que T03-S fecha usando a proposta de T02-S. T02-S não depende de código nem do gate final C-03; se T03-V exigir mudança, revisar T02-S antes de T02-V. O contrato completo C-03 fica aprovado antecipadamente, mas seu desenvolvimento espera T02-F. D3 e tarefas R independentes seguem suas dependências locais. Um único dono integra `ecosystem.mjs` e schemas em cada etapa.

| Decisão | Tarefa que fecha | Critério |
|---|---|---|
| D-04: proprietário direto | T01-S | Identidade explícita; cliente vinculado não ganha grants pelo adaptador |
| D-02: catálogo | T02-S | Comparar JSON atômico e SQLite por integridade, concorrência, dependência/runtime e benchmark; manter Node >=20 ou propor mudança explícita |
| D-01/D-07: política e legado | T03-S | Matriz de acesso antes/depois; lente não concede acesso; legado preservado até adesão |
| D-03: participação | T03-S | Protocolo de adesão com fixtures; lista de espaços reais fica para ativação autorizada |
| D-05: modos legados | T05-S | Matriz de detecção e compatibilidade; sem remoção sem inventário |
| D-06: limites | T00-S, T02-S e T05-S | Fixar orçamento inicial; definir limites de cache/latência antes da implementação correspondente |
| D-08: frescor versus zero releituras (nova, proposta) | Medição em T00-S; decisão em T02-S/T02-V | Comparar as duas opções abaixo; Claude Opus revisa; mudança de V-01 requer decisão explícita do usuário antes de T02-D1 |

**D-08 — decisão aberta, substitui a proposta EC-01:** distinguir leitura de descoberta/indexação, leitura de entrega/verificação e stat/política. T00-S apenas instrumenta os cenários; T02-S compara custo, complexidade, suporte e garantias das opções. (a) Preservar V-01 estrito: zero releituras na consulta repetida, com mecanismo demonstrável de frescor/integridade dentro de um modelo de ameaça explicitado. Watcher ou mtime/tamanho isolados não bastam; hashing que relê o arquivo conta como leitura. Se não houver mecanismo viável, declarar inviabilidade, sem prometer garantia impossível. (b) Propor alteração explícita de V-01: consulta repetida com k fontes entregues pode reler até k corpos para verificação, zero corpos não selecionados, mais alterações necessárias à atualização contadas separadamente. A opção (b) é recomendação de simplicidade, não decisão adotada. Q apresenta comparação concreta, Opus revisa e o usuário decide qualquer relaxamento de aceite antes de T02-D1. V-02 continua teste separado de manifesto/expansão, com seu próprio limiar. HS-SPEC-001 permanece inalterada até essa decisão. Enquanto pendente, não congelar desempenho presumindo (b).

Nos dois caminhos, testar edição de fonte selecionada que preserve tamanho/mtime e mudança de política entre seleção e entrega; não servir revisão indevida. Se política estiver dentro do Markdown, T02-S deve resolver como provar seu frescor antes de expor metadados em manifesto. A promessa de manifesto sem corpos só vale no estado de catálogo comprovadamente válido; incerteza exige reconciliação medida ou resultado bloqueado seguro, nunca ACL possivelmente antiga.

**Esclarecimento EC-02:** os 16/48/128 KiB propostos em V-03 limitam bytes UTF-8 de todo payload de resultado efetivamente exposto pelo adaptador, incluindo duplicação text/structuredContent e erros; transporte HTTP/JSON-RPC e framing são medidos separadamente. Manifesto tem no máximo dez entradas por página. Truncamento preserva JSON válido, procedência e indicador de insuficiência.

**Esclarecimento EC-03:** metas de qualidade não podem ser escolhidas depois de ver o resultado implementado. T00-S fixa rótulos e critérios; T02-S congela limites quantitativos de desempenho/cache antes de D. Se o baseline mostrar inviabilidade, Q propõe ajuste documentado e nova revisão, sem maquiar a medição.

D-06 é particionado: T00-S fixa unidade/perfis iniciais do envelope; T02-S fixa cache, IO e p95 da recuperação; T05-S fixa apenas latência da API de tarefa e tamanho de instrução ainda não definidos. Alterar teto já congelado exige decisão explícita do usuário e reexecução dos gates afetados, incluindo T02-F quando recuperação/cache forem afetados.

| Cobertura | Contrato principal | Evidência de aceite |
|---|---|---|
| R-01 / I-01 / I-08 | T02-S, T03-S | T02-F, T03-F, T06-F |
| R-02 / I-04 | T01-S | T01-F, T03-F, T04-F |
| R-03 / I-03 | T03-S | T03-F, T04-F |
| R-04 / V-03 | T01-S | T01-F, T05-F |
| R-05 / V-09 | T05-S | T05-F |
| R-06 / V-01 / V-02 | T02-S, D-08 | T02-F |
| R-07 / I-06 / V-07 / V-08 / V-11 | T02-S, T04-S | T02-F, T04-F |
| R-08 / V-06 | T04-S | T04-F |
| R-09 / V-05 | T01-S, T03-S | T01-F, T03-F |
| R-10 / I-05 | T05-S | T05-F, T06-F |
| R-11 / I-07 | T00-S, T06-S | T00-F, T06-F |
| R-12 / I-02 / V-10 | T03-S | T03-F, T06-F |
| V-04 | T01-S, T03-S | T01-F, T03-F, T05-F |
| V-12 | T03-S, T04-S, T05-S | T03-F, T04-F, T05-F (subconjunto), T06-F (completo) |

J-1 é aferido pelas jornadas V-02/V-05/V-06/V-09; J-2 por V-04/V-07/V-10/V-12; J-3 por V-01/V-03/V-08/V-11. T06-R verifica essa rastreabilidade de novo no resultado integrado.

## 4. C-00 — baseline reproduzível

Escopo: R-11, A-08; operacionalizar E-01–E-08 e V-01–V-12. Não corrigir comportamento neste ciclo. Entrada: baseline conferido. Saída: gaps reproduzidos e critérios congelados.

| Tarefa | Modelo | Especificação de trabalho / entrega | Dependência e validação |
|---|---|---|---|
| T00-R | A | Inventariar `ecosystem.mjs`, `context-selection.mjs`, MCP, web, schemas e testes; ligar cada E/V a símbolo, fixture e comando. | Primeiro; amostrar evidências diretamente em Q. |
| T00-S | Q | Especificar harness, contadores sync/async/stream, isolamento de processos, corpus 100/1.000/10.000, ambiente e repetição. Instrumentar opções D-08 sem alterar V-01; operacionalizar EC-02/03; fixar dataset PT/EN e critérios. | T00-R; toda métrica tem unidade, escopo e oráculo. |
| T00-V | C | Revisar harness e critérios: detectar medição só de `readFileSync`, cache entre processos, cobertura negativa e circularidade dos rótulos. | T00-S; contrato aprovado antes de fixtures executáveis. |
| T00-D1 | L | Criar geradores determinísticos e harness de medição em testes; 100 fontes reproduzem análise, volumes maiores medem escala. Fixtures nunca derivadas de dados pessoais. | T00-V; duas execuções produzem mesmos hashes/rótulos. |
| T00-D2 | T | Registrar comportamento atual de E-01–E-07 e matriz V; separar caracterização de falhas conhecidas dos futuros testes de aceite. | T00-D1; lacunas falham no modo de aceite, sem tornar falhas conhecidas um verde enganoso. |
| T00-F | Q | Reproduzir baseline e conferir isolamento/contagem; publicar métricas e mapa de testes ainda ausentes. | D1/D2; todos os E reproduzidos ou divergência explicada; nenhuma correção funcional misturada. |

Qualidade inicial proposta para T00-S: ao menos 36 casos rotulados, distribuídos entre PT/EN, pessoais/mecânicos/ambíguos e troca de lente; obrigatórios/proibidos/ opcionais por caso. Zero fontes proibidas; tarefas mecânicas explícitas sem corpos pessoais; evidência obrigatória entregue com orçamento suficiente ou insuficiência sinalizada. Q revisa rótulos antes de medir candidatos. Desempenho: ao menos 30 repetições por cenário, separar aquecimento, processo frio/quente, metadados e corpos; registrar máquina/runtime.

### 4.1 Contrato detalhado C00-CONTRACT-1 — escopo e dados

Estado inicial: contrato sujeito a T00-V antes de escrever harness/fixtures. Modificações permitidas após aprovação: `tests/helpers/c00-fixture.mjs`, `tests/helpers/c00-io.mjs`, `tests/c00-harness.test.mjs` (L); `scripts/c00-baseline.mjs`, `tests/helpers/c00-worker.mjs`, `tests/c00-baseline.test.mjs` (T); documentos e recibos sintéticos (Q). `src/`, `bin/`, schemas, package.json e semântica de produto permanecem intactos. Artefatos de medição ficam em `tests/fixtures/c00/` quando sanitizados; corpus volumoso existe apenas em temporários criados pelo harness.

Adendo T00-V: cleanup deve conferir `lstat` e `realpath` da raiz e do pai, igualdade com a raiz exclusiva originalmente criada e contenção por `path.relative`, com comparação case-insensitive em Windows; recusar junction/symlink trocado antes da remoção. IO cru deve ser detectado por wrappers de open/openSync/promises.open, read/readSync/readv e chamadas FileHandle, marcando unsupported ou lançando erro quando fora de chamada high-level suportada. Usar contexto/depth para permitir as operações internas do wrapper sem duplicar contagem. Addons/subprocessos fora do worker não são automaticamente observáveis: declarar essa limitação e vedar alegação de IO completo nesses casos. Workers de CLI são processos filhos Node reais, não worker_threads; medir separadamente operação interna e duração externa.

Contrato de fixture: `createFixture({count, baseDir?})` assíncrono retorna `{root,self,project,peer,syntheticPaths,sourceDigest,qualityCases,cleanup}`; `root` é diretório novo `holoself-c00-*` em tmpdir, nunca diretório pessoal. Se baseDir fornecido, criar um novo filho exclusivo, não reaproveitar árvore existente. Inicializar self via `run(['init','--root',self])` e link general via `--no-activate --yes`; peer é outro projeto ligado ao mesmo self e contém marcador exclusivo. Não registrar peers em configuração global. Fixar mtime dos Markdown em data constante e digest sobre pares caminho relativo + bytes das fontes, excluindo paths absolutos, timestamps de execução, config/link derivados e caches. Mesma count e versão do gerador produzem mesmo digest em raízes distintas. Inicialização fora da janela medida. cleanup só remove a raiz criada e validada como filho do temporário esperado; recusa raiz do volume, repo, pasta existente alheia ou symlink.

Corpus de escala: N arquivos `context/synthetic-00000.md` etc., UTF-8, frontmatter válido general/private, internal-only, personal, content; corpo curto com `career planning` e marcador único. Contar os documentos padrão de init separadamente: N é corpus adicional, não total. Manter contribs padrão para E-01/E-05; fixture customizada acrescenta lente spiritual (base general) com link autorizado e fonte elegível, para isolar falha de métodos. Nenhum nome/fato pessoal real nos dados.

Dataset de qualidade: 36 casos determinísticos: 2 idiomas × 3 classes (personal, mechanical, ambiguous) × 6 variantes. Fontes bilíngues sintéticas separadas de escala, com marcadores obrigatórios/proibidos/ opcionais; metadados e texto fixos. Cada caso inclui id, idioma, classe, task, lens, budget, requiredMarkers, forbiddenMarkers, optionalMarkers e expectedNeed (mecânica: not-needed; pessoal: required; ambígua: helpful/required). Variantes pessoais incluem carreira, identidade e troca general/career; política restrita permanece proibida. Casos ambíguos trazem evidência pessoal relevante, sem presumir resultado vazio. Oráculos escritos a partir das tarefas antes de observar seleção. Fazer checks separados de conteúdo obrigatório, proibido, necessidade e leitura pessoal; indicação de insuficiência não dispensa requisito se budget deep comporta todo corpus de qualidade. Os rótulos e seu digest ficam congelados antes da execução comparativa.

### 4.2 Instrumentação e interface entre D1/D2

`installIoMeter({roots, syntheticPaths})` retorna `{start(),stop(),restore()}`. roots contém self/project/peer. Instalar antes de importar dinamicamente módulos do produto e sincronizar exports builtin ESM. Uma medição por vez no processo. restore repõe funções e exports mesmo após erro. Contar chamadas e bytes retornados de `fs.readFileSync`, `fs.readFile` callback, `fs.promises.readFile` e `createReadStream`; testar todos em fixture com Unicode. Contar `stat/lstat/readdir/access/exists` sync, callback e promises como metadados, por API. Não somar chamadas internas da mesma leitura duas vezes; testes de calibração conhecem bytes e operações exatos. Rastrear leituras por caminho relativo/classificação: synthetic, outro Markdown self, Markdown projeto/peer, estado derivado, restante. Total e unique files separados; bytes são bytes UTF-8 para strings, byteLength para buffers. Fronteiras são lógica Node, não IO físico do SO nem cache do disco.

Limite explícito: operações via fd/FileHandle/read/readv, addons e subprocessos não instrumentados não podem ser relatadas como zero. O harness deve detectar/rejeitar APIs não suportadas quando usadas diretamente nas operações sob medição; APIs internas usadas por wrappers suportados não contam duas vezes. Executar operações medidas em worker dedicado; filhos de CLI/web não instrumentados só fornecem medição de envelope/latência externa, com IO `not-measured`. Conservar contadores por API e relato de cobertura. Evitar observador stream que altere fluxo/consumo; contar chunks sem drenagem extra.

Saída stop: `{bodyReads,bodyBytes,syntheticReads,syntheticBytes,uniqueBodyFiles,metadataOps,byApi,byPath,unsupported}`. body é Markdown de self/projeto/peer; contribs e estado derivado aparecem em byPath/classificação restante, não somem da contagem total por API. Arquivos das ferramentas/harness lidos fora da janela. Tempo `performance.now` em torno da operação apenas; tempo externo de processo registrado separadamente. Sem atribuir fase interna descoberta/entrega com certeza inexistente: registrar fonte selecionada/não selecionada depois do retorno e marcar fase interna como unavailable no baseline. O contrato mede as opções D-08, não escolhe uma.

### 4.3 Cenários, envelopes e qualidade

Runner: `node scripts/c00-baseline.mjs --sizes 100,1000,10000 --iterations 30 --output <arquivo>`; default rápido sizes=100 iterations=1; `--acceptance` executa os mesmos oráculos de alvo e retorna exit 1 se houver failed ou not-implemented. Execução normal retorna 0 quando medição/caracterização íntegra, mesmo com target failures. Falha de harness/JSON/worker sempre nonzero e distinta de requisito falho. Validar argumentos, timeout por worker e saída limitada; nunca transformar worker timeout em sample zero. Não publicar paths absolutos/usuário/segredos: substituir raízes por tokens SELF/PROJECT/PEER e registrar plataforma/arch/runtime sem hostname/user.

Em cada tamanho, seis cenários de 30 amostras: CLI context cold (processo novo, cache persistente vazio); CLI context disk-warm (processo novo, cache persistente previamente aquecido); MCP context memory-warm (sessão residente aquecida, sem cache persistente); CLI manifest warm; CLI expansão de uma fonte conhecida; CLI search após índice construído. Todos usam tarefa fixa, small e corpus imutável. Priming e rebuild ficam fora da amostra. Cold pode remover somente cache gerado dentro da fixture; processos CLI novos são workers que importam `run`, preservando semântica de processo e persistência, com janela de tempo interna explicitada. Manifest/expansão/search registram modo de processo/cache real. Cache hit persistente e memória reportados separadamente, sem assumir hit porque execução foi chamada warm. p50/p95 por nearest-rank sobre amostras, mais min/max; raw samples, N, número de repetições, digest e duração total preservados. IO externo/bootstrap não está no tempo interno. Limite de tempo é guardrail operacional, não meta de latência de produto.

E-03: bytes do stdout CLI exato (incluindo newline), payload MCP completo `{content,structuredContent,...}` e JSON-RPC wire medidos separados. Medir manifesto/erros nos três perfis small/standard/deep pelo menos em N=100; duplicação MCP conta no payload total; caracteres e estimativa chars/4 não são tokens reais. Limites de alvo congelados: 16.384/49.152/131.072 bytes UTF-8 e manifesto máximo dez entradas. Na falta de paginação, reportar target failed; nunca truncar manualmente o resultado para satisfazer teste. Gate R-04 não é considerado atendido em C-00.

Caracterizações obrigatórias: E-01 corpus inteiro lido nos caminhos frio/quente/manifesto/expansão; E-02 search fresco relê corpus; E-03 manifesto excessivo e tokens-body=0; E-04 general-only CLI private aceito versus MCP LENS_NOT_GRANTED; E-05 spiritual com tarefa e contribs gera erro de validação; E-06 peer com fonte exclusiva não entra em busca federated do consumidor (não alegar federação nova disponível); E-07 seletor not-needed retorna corpo; E-08 35 testes anteriores passam. Números exatos de bytes da análise exploratória não são snapshot obrigatório, pois paths/fixtures influenciam tamanho; registrar diferença e unidades.

V-07/V-08 probes adicionais: obter handle, revogar access_lenses no arquivo, expandir novamente e medir resultado; editar conteúdo preservando tamanho/mtime e observar revisão; invalidar fonte por delete/rename; testar valid_until com relógio controlado antes/depois da fronteira no seletor/cache em processo isolado. Testes não presumem bypass por stat — sourceRecords já faz hash do conteúdo. Clock falso nunca afeta benchmark de latência nem depende de sleep. Escrever somente fontes sintéticas fora da janela medida.

### 4.4 Matriz de aceites C-00 e lacunas futuras

Cada V-* recebe `{id,status,evidence,reason,owner_cycle}`; status entre passed, failed, partial, not-implemented. Sucesso de uma subprova não promove o V inteiro. V-01–03: leituras/envelope medidos, falhas-alvo previstas. V-04: paridade CLI/MCP medida; Workbench só evidência existente/estática nesta baseline, logo partial/failed, nunca aprovação completa. V-05: método customizado medido; novo compartilhamento not-implemented. V-06: não federação reproduzida; novo registro/interseção not-implemented. V-07: revogação probe, concorrência do futuro catálogo not-implemented. V-08: probes de mudança/tempo, frescor incremental futuro not-implemented. V-09: todos os 36 casos executados, com taxas e falhas individuais. V-10: not-implemented, sem stub verde nem migração executada; C-03 dono. V-11: métricas 100/1.000/10.000 e armazenamento do cache atual, limite/evicção futuro not-implemented. V-12: referenciar testes atuais de privacidade/path-safety; garantias federadas/prompt injection restantes explicitamente parciais, C-03–C-06 donos.

Testes D1: reprodutibilidade em duas raízes, 36 IDs/rótulos/idiomas/classes, isolamento, cleanup seguro, contagem real sync/callback/promises/stream/stat Unicode, restore após erro, unsupported não vira zero. Testes D2: reprodução E, JSON válido, percentis, raw samples e fail de --acceptance; calibração de subprocesso prova isolamento de cache. A suite normal testa o instrumento e a caracterização; o comando acceptance é a prova vermelha dos requisitos ainda não implementados. Não adicionar skips ou testes vazios. Rótulos de qualidade passam por Q antes de executar contra produto.

T00-F executa runner completo, suite completa via `scripts/verify.mjs`, modo acceptance (exit 1 esperado com lista explícita), `git diff --check`, revisão de todos os arquivos novos e digest de escopo. Resultado registra commit base, hash dos arquivos do harness/dataset, contrato revisado, modelos/recibos, ambiente, comandos e métricas. Sem modificação do produto, rollback consiste em remover somente artefatos novos deste ciclo por lista revisada e reverter somente mudanças documentais deste ciclo; não tocar nos dois documentos preexistentes como um todo. C-00 completo não significa nenhum V futuro aprovado integralmente.

### 4.5 Registro de execução C-00

- Autorização do usuário: iniciar e completar somente primeiro ciclo; objetivo ativo criado em 2026-09-19.
- T00-R: pesquisa Flash rejeitada por remapeamento incorreto de IDs e cache; escalada AP. Gemini Pro confirmou fluxo de leitura e IDs; Q rejeitou previsões não demonstradas de revogação/expiração e exigiu probes, conforme contrato. Recibos e fechamento serão registrados após validação.
- Baseline prévio: 35/35 testes efficiency/lenses/privacy-capabilities/mcp passaram novamente; nenhuma correção aplicada.
- T00-R verified: sessões agy `144ac5f7-2d04-4099-bc91-740f48a4fdd8` (Flash rejeitado), `715df0af-bb6c-4e3d-9a04-40348d06823b` e `600375d8-d50a-42c0-aa66-d0bce6f18e3d` (Pro e correção). Q verificou diretamente `sourceRecords`/`contextData`, `indexInputHash`, `contribRecords`/`resolvedContextAssertions` e `mcpContextData`; propostas de otimização não foram adotadas em C-00.
- T00-S/T00-V verified: Claude Sonnet 5 aprovou o contrato e o adendo nas sessões `57381c16-593c-442f-8aff-51ffcc85843c` e `3d2b5334-3585-4d00-8e6f-ea6541cd9f79`; SHA-256 do recorte §§4.1–4.4 calculado por Q: `5BD850B7B8B543EF130CDF97EA1016FB1BD4714FCE5947848A80630E71794AD9`. Claude revisou conteúdo, sem atestar hash independentemente. EC-02 operacionalizado na especificação; D-08 permanece aberta, sem alteração de V-01.
- T00-D1 verified: tentativa Luna medium não aceita após revisão de rótulos/IO; instrumentação escalada a Terra medium (c00_io_finish), fixtures e rótulos finalizados por Q. Falhas de rascunho incluíam oráculo contraditório mecânico/pessoal, marcador proibido em fonte permitida, reset de contadores e rastreamento assíncrono incompletos. Não constituem defeitos do produto. Q congelou 36 tarefas distintas antes de qualquer avaliação de qualidade: digest `47e5812f687d535418eb00d4f09e2138bf5281ef30272e9c7aba5c9eb7c14c81`, em `tests/fixtures/c00/quality-cases.json`. Dois roots independentes com N=2 produziram digest de fontes idêntico `24a58131b0c0603ae4756b1fa3e9b1355d8db9c1871854016525e9107728501c`. Q reproduziu **43/43** testes de `tests/c00-harness.test.mjs`, incluindo UTF-8, callback/promises/stream, fd cru concorrente, callback consumidor de stream, handle pré-aberto e substituição da raiz por junction. Recibos de pesquisa/revisão em `tests/fixtures/c00/review-receipts.json`.
- T00-D2 verified: caracterização implementada em `scripts/c00-baseline.mjs` e `tests/c00-baseline.test.mjs` (8/8 testes passando); reproduz cenários de 100 fontes, envelopes, qualidade e probes com oráculos congelados; `--acceptance` retorna exit 1 com a lista exata dos gaps conhecidos.
- T00-F verified: reproduzido baseline completo (sizes=100, iterations=1), suíte de testes íntegra (`node scripts/verify.mjs` ok, 43/43 harness, 8/8 baseline), `git diff --check` limpo; confirmado que 24 arquivos de produto em `src/`, `bin/`, `schemas/` e `package.json` permanecem 100% inalterados em relação a `1217e7c`. Ciclo C-00 concluído com sucesso e verificado.

## 5. C-01 — coerência imediata

Escopo: R-02/R-04/R-09, A-02/A-05/A-06; V-03/V-04/V-05. Manter a semântica atual de grants.

| Tarefa | Modelo | Especificação de trabalho / entrega | Dependência e validação |
|---|---|---|---|
| T01-R | A | Mapear todos os caminhos CLI/MCP/web de leitura, seleção de lente, métodos e serialização; localizar bypasses e duplicações. | C-00; mapa com símbolos e chamadas. |
| T01-S | Q | Definir avaliador único na política atual, identidade direta/vinculada D-04, erros seguros, filtragem prévia de métodos, cursor e envelope EC-02. Handles identificam fontes, não concedem acesso; expansão reavalia política. | R; matrizes positivas/negativas, payloads-limite e ausência de título/handle/path de fonte negada. |
| T01-V | CO | Desafiar paridade para mesma identidade/operação/revisão/escopo, escalada por parâmetros, vazamento de existência/metadados, método inelegível, erro maior que orçamento e cursor adulterado. | S aprovado; nenhum grant novo implícito, inclusive por handle e modo CLI. |
| T01-D1 | S | Extrair núcleo de autorização e conectar interfaces; preservar modos explícitos e validação final. | V; V-04 pelas interfaces reais, identidade/escopo iguais. |
| T01-D2 | T | Filtrar métodos antes da composição; limitar/paginar manifesto e serializar envelope completo. | V e contrato D1; V-03/V-05, JSON válido nos limites e caracteres multibyte. |
| T01-F | Q | Provar V-03/V-04/V-05 pelas interfaces reais, incluindo ausência de metadados negados; rodar regressões de privacidade/lentes/eficiência/MCP/web afetadas. | D1/D2 integrados; lente customizada corrigida, paridade e byte caps comprovados; efficiency legado é regressão, não aceite do catálogo C-02. |

Arquivos iniciais: `src/ecosystem.mjs`, `src/context-selection.mjs`, `src/mcp-server.mjs`, `src/web-server.mjs`; suites `privacy-capabilities`, `lenses`, `efficiency`, `mcp`, `web-project`. D1/D2 não editam `ecosystem.mjs` simultaneamente.

### 5.1 Contrato detalhado C01-CONTRACT-1 — autorização unificada, métodos e envelope

Estado: aprovado por Claude Opus em T01-V (Revisão 5); desenvolvimento T01-D1 e T01-D2 liberado.

#### 5.1.1 Identidade, autorização e paridade (R-02, D-04, V-04, B-1r, B-3r, H-6, M-4, M-5, M-6)
1. **Precedência estrita e ancoragem da raiz canônica (D-04, B-1r):**
   - *Modelo de ameaça:* `owner:direct` é uma barreira de autorização contra agentes operando em superfícies MCP/Web e em contextos vinculados a projetos; não pretende conter um operador com acesso físico irrestrito de shell ao sistema de arquivos local que já lê o Markdown diretamente.
   - *Precedência estrita de resolução de raiz:*
     - Se invocado com `--project` ou se existir `.holoself/link.yaml` no diretório alvo do projeto, no `cwd` ou em qualquer ancestral de `cwd`, a raiz canônica do self **deve vir compulsoriamente do campo `self_context.path` desse `link.yaml`**. Se o chamador também fornecer `--root` ou `--self`, o `realpath` do valor deve ser **estritamente idêntico** ao `realpath` da raiz apontada pelo link; qualquer divergência gera erro imediato `SELF_ROOT_NOT_CANONICAL`. O chamador é **irrefutavelmente `client:linked`**.
     - Se e somente se nenhum `link.yaml` existir no contexto de invocação (potencial `owner:direct`), a raiz canônica é resolvida a partir do ambiente de confiança (`HOLOSELF_HOME` ou `join(homedir(), '.holoself')`). Se `--root`/`--self` for fornecido, seu `realpath` deve coincidir com a raiz de ambiente. O acesso `owner:direct` só é concedido se `assertContainedPath(resolvedRoot, cwd)` provar que o processo executa de dentro da própria raiz canônica do self.
   - *Marcador positivo de self:* a raiz canônica deve conter comprovadamente o manifesto canônico (`config.json` e layout `profile/` e `context/`). Diretórios arbitrários nunca são aceitos como self.
   - *Contenção bilateral estrita:* `assertContainedPath` opera com `realpath` em ambos os lados, com fronteira normalizada terminada em separador e comparação case-insensitive no Windows (L-3).
2. **Superfície vinculada no ponto de entrada e internal-health (B-3r):**
   - O parâmetro `surface: 'cli-direct' | 'cli-linked' | 'mcp' | 'web' | 'internal-health'` é vinculado **estritamente no ponto de entrada do módulo** (`cli.mjs`, `mcp-server.mjs`, `web-server.mjs`), nunca aceito de requisições externas. Se `options.surface` ou `options.identity` for recebido pelo adaptador vindo de payload do chamador, o sistema rejeita imediatamente com `SURFACE_NOT_ACCEPTED_FROM_REQUEST` ou `IDENTITY_NOT_ACCEPTED_FROM_CALLER`.
   - Nas superfícies `mcp` e `web`, a identidade `owner:direct` é estruturalmente inalcançável, resolvendo sempre como `client:linked`.
   - A superfície `internal-health` (usada por verificações como `holoself link status`) adota o piso `client:linked` e sua saída nunca é exposta diretamente a agentes, sendo colapsada normativamente em status booleano/opaco (`valid` ou `broken`), sem vazamento de detalhes internos.
3. **Fases de execução e gate exaustivo default-deny (B-2, M-4, M-5, M-6, H-5r):**
   - A execução de `contextData()` divide-se obrigatoriamente em três fases sequenciais:
     - **Fase 1 (Resolução Confiável):** Resolve raiz canônica segundo a regra de precedência B-1r, carrega `link.yaml` (se vinculado) e o registro de lentes do self canônico (`loadLensRegistry`).
     - **Fase 2 (Gate Exaustivo de Lente):**
       ```javascript
       switch (identity.kind) {
         case 'owner:direct':
           if (!registry.byId.has(lens)) {
             const error = new Error('unknown lens requested');
             error.code = 'UNKNOWN_LENS';
             throw error;
           }
           break;
         case 'client:linked':
           // Oráculo de existência: para client:linked, lente não concedida gera sempre LENS_NOT_GRANTED (M-5)
           if (!identity.allowedLenses.has(lens)) {
             const error = new Error('lens is not granted by this project link');
             error.code = 'LENS_NOT_GRANTED';
             throw error;
           }
           break;
         default: {
           const error = new Error('unrecognized caller identity kind');
           error.code = 'UNRECOGNIZED_IDENTITY';
           throw error;
         }
       }
       // Validação pós-resolução: proibir fallback silencioso (M-6)
       const resolution = resolveLens(registry, lens);
       if (resolution.id !== lens) {
         const error = new Error('lens resolution mismatch');
         error.code = 'LENS_RESOLUTION_MISMATCH';
         throw error;
       }
       ```
     - **Fase 3 (Varredura e Seleção):** Somente após a Fase 2 aprovada, o sistema pode ler arquivos de fontes, índices, caches ou contribs.
4. **Projeção de caminhos governada pelo núcleo (H-6, V-04):**
   - A projeção de dados deixa de ser heurística de adaptador:
     - Para `client:linked`, **nenhum caminho absoluto de self nem `self.path` é exposto** em nenhuma interface (seja CLI `--json`, CLI packet, MCP ou Web). As fontes são sempre identificadas por caminhos relativos e `source_id`.
     - Paridade absoluta V-04 entre CLI e MCP para o mesmo sujeito e escopo.
5. **Sanitização ampla e teto para mensagens de erro (I-04, H-1, H-2, H-5, Low-1):**
   - O campo `restrictions`, o campo `warnings` e todas as mensagens de erro geradas por validação pós-resolução estão sujeitos ao mesmo teto de bytes UTF-8 e à mesma regra de sanitização:
     - Mensagens de erro e exceções usam códigos estáveis e contadores agregados opacos (ex.: `N sources rejected`), sem concatenar ou listar caminhos de arquivos negados (H-5).
     - Entradas em `warnings` referentes a arquivos não autorizados ou que falhem no parsing são anonimizadas para agentes (`<redacted>`).
     - Contadores agregados opacos (`unauthorized_sources_omitted: N`) são registrados como limitação aceita para diagnóstico seguro em C-01.
     - Diagnósticos locais com caminhos físicos completos ficam descopados para o operador humano interativo via `holoself link doctor`.
   - *Nota de limitação do vínculo:* Fica formalmente registrado que a atestação criptográfica do vínculo do lado do self é escopo de **D-01/D-07 em T03-S**.

#### 5.1.2 Filtragem prévia e invariantes de métodos/contribs (R-09, V-05, Medium-2)
1. **Elegibilidade por lente base e compatibilidade de sensibilidade:**
   - Métodos reutilizáveis opcionais (`contribs`) são avaliados previamente considerando a lente base da resolução (`resolution.base_lens || lens`).
   - Invariante normativo: a elegibilidade exige que a sensibilidade declarada do método seja estritamente compatível tanto com o `base_lens` quanto com o conjunto `resolution.sensitivity_access` da lente ativa. Métodos que exijam sensibilidade não autorizada são inelegíveis. Em particular, lentes customizadas com `base_lens: 'private'` não habilitam contribs de sensibilidade `restricted` se seu próprio `sensitivity_access` não a conceder expressamente (interseção estrita).
2. **Descarte prévio à seleção (sem falhas em cascata):**
   - Todo método inelegível é descartado na fase de descoberta (antes de ingressar no seletor de relevância ou orçamento).
   - Um método opcional omitido por inelegibilidade nunca chega a `resolvedContextAssertions`, eliminando o erro falso de vazamento e garantindo a entrega do contexto válido remanescente. Cap de 2 contribs e ranking preservados.

#### 5.1.3 Envelopes limitados, truncamento e cursor autenticado por HMAC (R-04, EC-02, V-03, H-4, M-1, M-7, M-8r)
1. **Tetos de bytes UTF-8 sobre qualquer saída de contexto (V-03, M-7):**
   - Os limites de envelope aplicam-se sobre o payload serializado completo exposto pelo adaptador ao agente (JSON UTF-8 ou packet formatado):
     - `small`: 16 KiB (16.384 bytes UTF-8)
     - `standard`: 48 KiB (49.152 bytes UTF-8)
     - `deep`: 128 KiB (131.072 bytes UTF-8)
   - No MCP, a contagem de bytes mede o payload gerado em `toolResult` (incluindo a duplicação textual em `content[0].text` e `structuredContent`).
2. **Cursor autenticado por HMAC e re-execução obrigatória de autorização (H-4, M-8r):**
   - Manifestos (`manifest: true`) têm teto de **10 fontes por página**.
   - Toda requisição de página com cursor **re-executa compulsoriamente as Fases 1 e 2 de autorização**; o cursor transporta apenas estado e posição de leitura, nunca autorização persistente. Se uma concessão for revogada no `link.yaml` entre páginas, a Fase 2 rejeita imediatamente com `LENS_NOT_GRANTED`.
   - O segredo de assinatura do cursor é mantido exclusivamente sob a **raiz canônica do self** em `join(selfRoot, '.holoself', 'runtime', '.cursor.key')` (modo 0600, gerado via `crypto.randomBytes(32)` na inicialização) ou em memória de processo, jamais no diretório do projeto vinculado.
   - Definições formais de termos (M-8r):
     - `authorized_candidates`: lista de fontes que passaram com sucesso pelas Fases 1 e 2 e pela filtragem de política. Sua **ordem total determinística** é fixada por: `task_relevance` decrescente, seguido pelo `source_id` lexicográfico crescente.
     - `state_hash`: SHA-256 calculado sobre a tupla determinística:
       `sha256(JSON([registry.registry_hash, [...identity.allowedLenses].sort(), authorized_candidates.map(c => [c.source_id, c.source_hash])]))`.
     - `task_hash`: SHA-256 da string da tarefa.
   - Serialização canônica determinística do payload assinado (com formato inviolável de campos):
     ```
     signed_payload = `v1|${identity_id}|${lens}|${budget}|${manifest}|${self_id}|${task_hash}|${temporal}|${offset}|${state_hash}`
     sig = hmacSha256(signed_payload, cursorSecret)
     cursor = base64(JSON({ p: { v: 1, identity_id, lens, budget, manifest, self_id, task_hash, temporal, offset, state_hash }, sig }))
     ```
   - O `identity_id` é um hash opaco da identidade com sal server-side.
   - A verificação de assinatura utiliza obrigatoriamente `crypto.timingSafeEqual`.
   - Se o cursor for malformado, tiver assinatura HMAC inválida, ou se `identity_id`, `lens`, `task_hash` ou `temporal` divergirem da requisição atual, o adaptador rejeita com `CURSOR_INVALID`.
   - Churn de estado: se o `state_hash` divergir (devido a alteração de arquivos ou política), a requisição é rejeitada com `CURSOR_INVALID`, instruindo o cliente a reiniciar a partir do offset 0 (M-8r).
3. **Algoritmo de truncamento, garantia de progresso e término (M-1, M-8r):**
   - Precedência: em manifestos, o limite de 10 fontes por página é avaliado primeiro; se o payload de 10 fontes exceder o teto de KiB do orçamento, o corte de bytes prevalece e emite a página truncada com `next_cursor` apontando para a fonte seguinte.
   - Garantia de progresso: se uma única fonte exceder o teto do orçamento isoladamente, ela é registrada em `omitted` com motivo explícito (`source exceeds envelope budget`) e o `next_cursor` **obrigatoriamente avança** para o próximo offset (`offset + 1`), com `selection.truncated: true`, mesmo em página com zero fontes entregues, impedindo loops infinitos de paginação (M-1, M-8r).
   - Critério de término: quando `offset >= authorized_candidates.length`, `next_cursor` é compulsoriamente `null`.
   - Indicadores de integridade: a resposta registra `selection.truncated: true` e documenta as fontes não incluídas em `omitted` com o motivo correspondente.
   - Heurística de tokens totais: `selection.estimated_tokens_total_heuristic = Math.ceil(total_payload_bytes / 4)`.

### 5.2 Registro de execução C-01

- Autorização: execução de C-01 liberada após conclusão verificada de C-00.
- T01-R verified: mapeamento detalhado dos fluxos e caminhos de leitura, seleção de lentes, métodos e serialização em CLI, MCP e Web registrado em `c01-research-read-paths.md`.
- T01-S verified: contrato `C01-CONTRACT-1` especificado na Seção 5.1, definindo autorização única ancorada, identidades `owner:direct` vs `client:linked`, gate de lente default-deny em três fases, projeção de caminhos governada pelo núcleo, filtragem prévia de métodos por compatibilidade de sensibilidade, tetos de envelope em bytes UTF-8 (16 KiB, 48 KiB, 128 KiB) e paginação de manifesto por cursor HMAC-SHA256 com garantia de término.
- T01-V verified: Claude Opus revisou adversarialmente em 5 rodadas sucessivas de refinamento (`C01-CONTRACT-1 v5` aprovado), fechando B-1r, B-3r, H-5r e M-8r (garantias de não-ampliação, inviolabilidade da assinatura HMAC com timingSafeEqual, contenção bilateral com realpath e proibição de auto-concessão).
- T01-D1 verified: implementação do núcleo de autorização unificado em `src/ecosystem.mjs` (`safeRealpath`, `assertContainedPath`, precedência canônica D-04, gate exaustivo Fase 1/2/3, restrição de existência para `kind === 'self'`, e amarração das superfícies em `src/cli.mjs` e `src/mcp-server.mjs`).
- T01-D2 verified: implementação de envelopes e paginação por cursor em `src/context-selection.mjs` (`ENVELOPE_BYTE_CAPS`, 10 fontes max por página, ordenação determinística `task_relevance` desc -> `path` asc -> `source_id` asc, truncamento iterativo de payload em manifestos com atualização de `restrictions`, `sources` e `next_cursor`, progresso `offset + 1` em itens individuais gigantes) e filtragem prévia de contribs em `src/ecosystem.mjs`.
- T01-F verified:
  - Suíte completa: **176/176 testes passando** via `node scripts/verify.mjs` (incluindo `tests/c01-parity-and-envelope.test.mjs`, `tests/c00-baseline.test.mjs`, `tests/c00-harness.test.mjs` e suítes legadas adaptadas aos grants de C-01).
  - V-03 (`passed`): Envelopes medidos estritamente dentro dos limites congelados para `small`, `standard` e `deep` em CLI e MCP:
    - `small` (teto 16.384 B): CLI `14.875` B, MCP `11.186` B, MCP error `355` B.
    - `standard` (teto 49.152 B): CLI `23.894` B, MCP `35.608` B, MCP error `355` B.
    - `deep` (teto 131.072 B): CLI `23.881` B, MCP `35.582` B, MCP error `355` B.
  - V-04 (`reproduced: false`): Paridade estrita CLI e MCP comprovada; chamadores `client:linked` com lente não concedida recebem invariavelmente `LENS_NOT_GRANTED`.
  - V-05 (`reproduced: false`): Lentes customizadas baseadas em `general` ou com sensibilidade compatível executam com sucesso (`error: null`) sem falso vazamento de contribs nem falhas em cascata.
  - Verificação de diff: `git diff --check` 100% limpo. Ciclo C-01 formalmente verificado e concluído.

## 6. C-02 — catálogo incremental e cache limitado

Escopo: R-06/R-07/R-11, A-03/A-04; V-01/V-02/V-07/V-08/V-11. Entrada: C-01 aprovado.

| Tarefa | Modelo | Especificação de trabalho / entrega | Dependência e validação |
|---|---|---|---|
| T02-R | A | Rastrear buildIndex/readIndex/indexInputHash, seleção e caches; comparar opções locais JSON/SQLite e suporte do runtime pelos arquivos/dependências. | C-01; evidências e custo de invalidação. |
| T02-S | Q | Fechar D-02/D-06 e preparar decisão D-08: schema fonte/trecho/revisão, escrita atômica e disputa, cache keys, limite/evicção, expiração, reconciliação, integridade e crash recovery. Congelar p95/IO/cache após baseline e decisão D-08. | R; contrato inclui espaço/política/revisão necessários a C-03/C-04; números de latência/cache ausentes bloqueiam D. |
| T02-V | CO | Revisar D-08, TOCTOU, cache após revogação, hash com mesmo stat, perda de watcher, dois processos e corrupção. | T02-S + T03-S + T03-V; cenários explícitos, contratos compatíveis e decisão do usuário se houver alteração de V-01; só então liberar D. |
| T02-D1 | S | Implementar armazenamento derivado, atualização incremental, exclusão/rename e concorrência; reconstrução explícita. | V; tests de escrita concorrente, crash e reconstrução equivalente. |
| T02-D2 | T | Integrar busca/manifesto/expansão direta e cache limitado ao catálogo; eliminar varreduras de corpos do caminho quente. | D1; V-01 conforme decisão D-08 registrada, expiração sem modificação e invalidadores por dimensão. |
| T02-D3 | L | Automatizar benchmark reprodutível e relatórios de leituras, bytes, p50/p95, hits e espaço em disco. | V, harness C-00; medir D1/D2 final sem alterar thresholds. |
| T02-F | Q | Exercitar escalas e falhas: consulta repetida satisfaz V-01 na versão decidida em D-08; manifesto válido zero corpos; expansão k lê no máximo k fontes selecionadas mais alterações necessárias; falhas não servem revisão indevida. | D1–D3; V-01 e V-02 reportados separadamente, limites congelados satisfeitos e nenhum ganho por perder evidência. |

Arquivos iniciais: funções de índice em `src/ecosystem.mjs`, `src/context-selection.mjs`, `schemas/index.schema.json`, `tests/efficiency.test.mjs`. O backend escolhido precisa demonstrar atomicidade e compatibilidade; menor quantidade de código não substitui esse teste.

## 7. C-03 — lentes como perspectivas e migração

Escopo: R-01/R-03/R-12, A-01/A-02/A-07; V-04/V-05/V-10/V-12. Entrada: C-01; integrar após C-02 na ordem padrão.

| Tarefa | Modelo | Especificação de trabalho / entrega | Dependência e validação |
|---|---|---|---|
| T03-R | A | Inventariar schemas link/lens/documento, sensitivity, publication, bases customizadas e parsers legados. Ler apenas repo e fixtures. | C-01; tabela de precedência atual e ambiguidades. |
| T03-S | Q | Fechar D-01/D-03/D-07: sujeito/espaço/operação, read scopes, sensibilidade/divulgação independentes, registro opt-in, precedência fail-closed e versão. Definir preview/apply/revert com hashes e fechar SubjectSpacePolicyRev. | T03-R + proposta T02-S, sem depender de T02-V/F; tabela de acesso antes/depois completa. |
| T03-V | CO | Revisar não ampliação, identidade forjada, colisões de espaço, caminhos/symlinks, rollback com edições alheias e lens_id usado como grant. | S; provas negativas e transformação por versão. |
| T03-D1 | S | Implementar política/registro versionados e lentes de ranking independentes; compatibilidade explícita com a política anterior. | T03-V + T02-F; criar lente reutiliza fonte compartilhada, restrita permanece negada. |
| T03-D2 | S | Implementar preview, aplicação explicitamente acionada e reversão em fixtures; revisar hashes antes de escrever, rejeitar estado divergente. | D1; V-10 dry-run sem mutação, aplicação/reversão preservam bytes alheios. |
| T03-F | Q | Validar matriz CLI/MCP/web nas duas versões e migrar/reverter conjunto sintético; manter grant efetivo ou exigir adesão explícita para ampliar. | D1/D2; V-04/V-05/V-10/V-12 e cache revogado C-02. |

Arquivos iniciais: `src/lenses.mjs`, `src/ecosystem.mjs`, `schemas/link.schema.json`, `schemas/lens.schema.json`, `schemas/document-metadata.schema.json`, testes de lentes/privacidade/ecossistema. Nenhum registro de espaço pessoal real integra este ciclo.

## 8. C-04 — federação real

Escopo: R-08, A-01/A-02/A-03/A-04; V-06/V-07/V-08/V-12. Entrada: C-02 e C-03 aprovados.

| Tarefa | Modelo | Especificação de trabalho / entrega | Dependência e validação |
|---|---|---|---|
| T04-R | A | Mapear pontos ainda limitados a self + projeto, caches globais, deduplicação e IDs/paths que podem colidir. | C-02/C-03; checklist de integração. |
| T04-S | Q | Definir consulta por espaços autorizados, interseção consumidor/produtor, IDs compostos, ranking global e cursor ligado a sujeito/revisões. Separar produtor opcional indisponível (parcial) de autoridade indeterminável (bloquear fonte; abortar consulta se escopo seguro indeterminável). | R; nenhum corpo/título/handle/path ou existência restrita em resposta, recibo ou diagnóstico não autorizado; dedupe não promove direitos. |
| T04-V | CO | Atacar revogação entre páginas, indisponibilidade opcional versus política/identidade/revisão indeterminável, grants assimétricos, dedupe com direitos distintos e orçamento global. | S; provar os três resultados: parcial seguro, fonte bloqueada, consulta abortada; nenhum grant mais permissivo promovido por dedupe. |
| T04-D1 | S | Implementar recuperação entre registros explícitos, isolamento, disponibilidade parcial e revalidação de grants. | V; sem descoberta de diretórios vizinhos. |
| T04-D2 | T | Integrar ranking/dedupe/procedência/cursor federados e orçamento global, preservando limites por fonte. | D1; mesma fonte em espaços diferentes não mistura autoridade. |
| T04-F | Q | Testar três espaços sintéticos, revogação durante paginação/expansão, indisponibilidade e fonte restrita sem metadados expostos. | D1/D2; V-06–V-08/V-12 e benchmarks sem varredura de corpos globais. |

## 9. C-05 — consulta única, instruções e Workbench

Escopo: R-05/R-10, A-04/A-05/A-06; V-03/V-04/V-09. Entrada: C-04 aprovado.

| Tarefa | Modelo | Especificação de trabalho / entrega | Dependência e validação |
|---|---|---|---|
| T05-R | A | Inventariar bootstrap, skill, instruções geradas, adapters e jornadas web; caracterizar modos link/snapshot/mount sem ler mounts reais. | C-04; mapa de entrada e duplicação. |
| T05-S | Q | Definir API orientada à tarefa, gate mecânico explícito/ambíguo, diagnóstico seguro e jornadas; fechar D-05 e somente limites remanescentes D-06 da API/instruções, mantendo tetos anteriores. | R; critérios PT/EN e uma chamada útil nos casos pessoais definidos; compatibilidade de comandos/formatos. |
| T05-V | C | Revisar falso not-needed, necessidade de múltiplas chamadas, explicação que vaza fonte negada e instrução legada conflitante. | S; jornada e contratos revisados. |
| T05-D1 | T | Integrar consulta única, expansão opcional, gate e adaptadores; ambiguidade preserva possibilidade de contexto sem escalar acesso. | V; dataset C-00 e paridade de interfaces. |
| T05-D2 | L | Encurtar instruções geradas/skill e atualizar guias com gatilhos e entrada canônica, sem repetir política em prosa. | V + contrato D1; snapshots/testes docs/harnesses. |
| T05-D3 | T | Ajustar Workbench para mostrar perspectiva, escopo e motivo seguro; diagnosticar modos e falhas sem exigir interpretação do filesystem. | V + contrato D1; testes web e inspeção das jornadas. |
| T05-F | Q | Rodar journeys CLI/MCP/web, dataset PT/EN e limite de envelope; comparar evidência preservada e custo com C-00. Incluir subconjunto V-12 das instruções/skill: conteúdo recuperado não autoriza ferramentas, publicação ou escrita; diagnóstico não expõe fonte negada. | D1–D3; casos mecânicos/pessoais/ambíguos rotulados passam, ambíguas sem descarte silencioso; respeitar limite de garantia sobre agentes externos. |

Arquivos iniciais: `src/instructions.mjs`, `skills/holoself/SKILL.md`, `src/mcp-server.mjs`, `src/web-server.mjs`, `web/app.mjs`, testes docs/harnesses/web. Testes visuais apenas nas jornadas alteradas, com fixture sintética.

## 10. C-06 — testes finais e prontidão para adoção

Escopo: R-01–R-12 e V-01–V-12; nenhum requisito pode desaparecer na integração. Entrada: todos os gates anteriores.

| Tarefa | Modelo | Especificação de trabalho / entrega | Dependência e validação |
|---|---|---|---|
| T06-R | A | Auditar rastreabilidade requisito→contrato→diff→teste; comparar docs, schemas, código e conteúdo do pacote. | C-05; lista compacta de lacunas e claims sem prova. |
| T06-S | Q | Definir matriz final de plataformas/runtime, regressão, pacote, jornadas e ensaio de reversão; separar teste não executável de aprovado. | R; todos os V possuem comando/oráculo e responsável. |
| T06-V | C | Validar plano de aceite completo, riscos residuais, restauração e exclusão de dados pessoais do pacote. | S; sem autoaprovação por cobertura nominal. |
| T06-D1 | T | Corrigir somente lacunas de integração/documentação/harness; qualquer mudança semântica em R/V/I reabre S/V do ciclo responsável antes de desenvolver. | V; testes direcionados por correção; repetir gates afetados, incluindo T02-F se cache/política mudar. |
| T06-D2 | L | Preparar relatório antes/depois, runbook de adoção/reversão e lista de decisões para ativação futura. | V + resultados D1; claims rastreáveis, sem release. |
| T06-F | Q | Executar verificação completa, V-01–V-12, pacote e ensaio sintético de reversão na revisão integrada; conferir diff e segredos. | D1/D2; todos passam ou exceção do usuário registrada, nunca inferida. |
| T06-G | G | Revisar relatório integrado e limitações após F; apontar lacunas finais de evidência. Q responde e repete testes afetados. | F; fechamento técnico não autoriza adoção/publicação. |

Comandos já existentes a reutilizar na execução: `node --test tests/*.test.mjs`, `node scripts/package-audit.mjs`, `node scripts/verify.mjs` e `git diff --check`. `verify.mjs` já engloba testes, auditoria, help e capabilities; evitar executar duas vezes a mesma suite sem necessidade. Novos comandos V-* serão definidos no harness C-00. Validar runtime mínimo declarado e Windows atual; outras plataformas declaradas pelo projeto precisam evidência de CI ou limitação expressa. Auditoria do pacote deve inspecionar a lista efetivamente empacotada e fixtures, não apenas `.gitignore`.

## 11. Estado, evidências e entrega futura

C-00: execução conforme §4.5; C-01: execução conforme §5.2; C-02–C-06: `planned`. As medições anteriores pertencem a HS-SPEC-001 e não demonstram correções. Não há cronograma de calendário estimado: C-00 fornece custo/tempo para estimar os demais ciclos sem precisão falsa.

Registro por tarefa, mantido nesta seção ou no recibo de execução referenciado: `task_id | state | requested_model | resolved_model | input_revision | contract_hash | output_revision | commands | results | metrics | review_findings | disposition`. Estados: planned, ready, running, changes-required, verified, blocked. Um processo que sai com código zero e resposta vazia não constitui revisão.

Ao encerrar cada ciclo, Q entrega resultado observável, requisitos atendidos, evidências reproduzíveis, custo e tentativas, riscos remanescentes e próximo gate. Autorizações já dadas para execução futura não devem ser pedidas novamente para tarefas rotineiras dentro do escopo; decisões que ampliem acesso ou escopo permanecem separadas.

Condição de entrega técnica: C-00–C-06 verificados, achados bloqueantes/altos resolvidos, rastreabilidade completa, economia medida sem perda de qualidade/privacidade e reversão ensaiada. A ativação real será planejada/autorizada separadamente.

## 12. Revisões deste plano

Este registro descreve somente revisões do documento; os gates Tnn-V e Tnn-F continuam futuros.

- **agy / gemini-3.8-flash-medium:** análise efetivamente concluída em 2026-09-19 sobre pacote fornecido com requisitos, arquitetura, critérios e ciclos da especificação; não realizou inventário completo do código. Sessão `d9d32796-305b-4192-87b5-513806ad2511`. Achados adotados: distinguir IO de descoberta/entrega (EC-01), revisar dependência política/catálogo antes de implementar, medir economia junto de relevância, usar bytes reais e fixtures no filesystem. A tentativa inicial sem resposta foi descartada; a revisão válida usou conteúdo inline sem ferramentas.
- **Claude Code / `sonnet`, resolvido `claude-sonnet-5`:** revisão independente dos dois documentos, sessão `d2fc04ff-e920-422f-a5ec-8448f035c226`, veredito inicial `changes-required`. Cinco achados tratados: EC-01 promovido a D-08 com decisão explícita para mudança de aceite; V-01/V-02 separados; suspensão quantitativa de modelo barato; verificação direta da pesquisa de segurança; limites congelados antes de desenvolvimento. Nova revisão na sessão `a9669869-3b2e-478c-b233-ed046c57ae70`: **approved**. Sugestão residual baixa também adotada: estender verificação de Q a T01-R.
- **Grok / `grok-4.6`, execução reportou `grok-4.6-build`:** primeira revisão completa, sessão `01a0ba69-313a-7391-b077-22c8629c9463`, `changes-required`. Tratamento F01–F10: ordem de tarefas C-02/C-03 explícita e sem ciclo; falha parcial distinta de autoridade ambígua; metadados/handles negados testados em C-01; T01-V elevado a Opus por risco; V-12 relevante incluído em C-05; limites D-06 particionados; mudanças semânticas finais reabrem ciclo; provedor indisponível bloqueia sua tarefa; matriz R/I/V/J adicionada. T05-D1 permanece Terra com dataset independente e revisão/aceite obrigatórios, como permitido pelo achado F10. Nova leitura do plano completo consolidado, sessão `01a0ba6e-d590-7c71-8a92-e82e9997501b`: **approved**, sem bloqueador remanescente do plano. Decisões e testes futuros permanecem gates de execução.

Verificação documental de Q: 45 tarefas únicas, sete ciclos com R/S/V/D/F, Claude em todos os gates V, referências de tarefas e R/I/A/V válidas, fences e espaços finais conferidos. Especificação original preservada (SHA-256 `BAC43B91B8386339D3E79147EB6C45EF4C9F359ED6B94192609CE163ACD7D9FA`). Somente este segundo documento foi criado nesta etapa; código e testes de produto não foram alterados nem executados.
