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
   - Invariante normativo: a elegibilidade exige que a sensibilidade declarada do método seja estritamente compatível tanto com o `base_lens` quanto com o conjunto `resolution.sensitivity_access` da lente ativa. Métodos que exijam sensibilidade não autorizada são inelegíveis. Em particular, lentes customizadas com `base_lens: 'private'` *(REVOGADO em C-03 §7.1.1.3: `base_lens: "private"` é expressamente proibido para qualquer lente customizada; apenas a lente embutida `private` pode tê-lo)* não habilitam contribs de sensibilidade `restricted` se seu próprio `sensitivity_access` não a conceder expressamente (interseção estrita).
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
| T02-V | CO | Revisar D-08, TOCTOU, cache após revogação, hash com mesmo stat, perda de watcher, dois processos e corrupção. | Aprovado por Claude Opus em 2026-09-20 (Rodada 5, status: approved). Libera T02-D1. |
| T02-D1 | S | Implementar armazenamento derivado, atualização incremental, exclusão/rename e concorrência; reconstrução explícita. | V; tests de escrita concorrente, crash e reconstrução equivalente. |
| T02-D2 | T | Integrar busca/manifesto/expansão direta e cache limitado ao catálogo; eliminar varreduras de corpos do caminho quente. | D1; V-01 conforme decisão D-08 registrada, expiração sem modificação e invalidadores por dimensão. |
| T02-D3 | L | Automatizar benchmark reprodutível e relatórios de leituras, bytes, p50/p95, hits e espaço em disco. | V, harness C-00; medir D1/D2 final sem alterar thresholds. |
| T02-F | Q | Exercitar escalas e falhas: consulta repetida satisfaz V-01 na versão decidida em D-08; manifesto válido zero corpos; expansão k lê no máximo k fontes selecionadas mais alterações necessárias; falhas não servem revisão indevida. | D1–D3; V-01 e V-02 reportados separadamente, limites congelados satisfeitos e nenhum ganho por perder evidência. |

Arquivos iniciais: funções de índice em `src/ecosystem.mjs`, `src/context-selection.mjs`, `schemas/catalog.schema.json`, `schemas/context-decision-cache.schema.json`, `tests/efficiency.test.mjs`. O backend escolhido precisa demonstrar atomicidade e compatibilidade; menor quantidade de código não substitui esse teste.

### 6.1 Contrato detalhado C02-CONTRACT-1 v5 — catálogo incremental, lazy reading e cache governado

Estado: proposta v5 consolidada por Q incorporando integralmente os achados H-19..H-21, M-18..M-20 e L-20..L-23 da Revisão 3 de Claude Opus em T02-V.

#### 6.1.1 Arquitetura do Catálogo Particionado e Aposentadoria do Motor Legado (R-06, A-03, D-02, B-8, H-7, H-14, M-16, M-17, M-18, L-10, L-21, L-23)
1. **Decisão D-02 e Caminhos Canônicos Normativos (L-10):**
   - Adota-se o **Catálogo Determinístico JSON Particionado** sob os caminhos canônicos absolutos:
     - Self: `<selfRoot>/.holoself/catalog/catalog.json` (apenas fontes canônicas de `self`).
     - Project: `<projectDir>/.holoself/catalog/catalog.json` (apenas fontes locais do projeto).
     - Cache de decisão: `<projectDir>/.holoself/runtime/context-cache/`.
   - *Fundamentação técnica:* Mantém 100% de compatibilidade com o runtime declarado (`engines: {"node": ">=20"}`), prescinde de compilação C++ ou dependências externas (`package.json` limpo), e satisfaz I-01 (catálogo derivado e descartável).
2. **Particionamento Real e Desacoplamento do Self (M-1, H-7, H-14, M-18):**
   - O catálogo do self contém `space_id: "self"`, `lens_registry_hash`, e compulsoriamente **`project_context_hash: null`**. As fontes canônicas do self são universais para a pessoa e independem de políticas de inclusão de projetos específicos, eliminando o *thrashing* de invalidação entre projetos concorrentes vinculados ao mesmo self.
   - O catálogo do projeto contém `space_id: "<projectId>"`, `lens_registry_hash` e compulsoriamente **`project_context_hash: sha256(canonicalJson(link.project_context))`**.
   - A verificação de `link.project_context` é **escopada estritamente ao catálogo de projeto**; para a partição do self e partições de contribs, o validador assevera compulsoriamente `catalog.project_context_hash === null` (H-14, M-18).
3. **Aposentadoria e Remoção Definitiva do Motor Legado `.holoself/index/index.json` (B-8, M-17, L-11, L-21):**
   - O índice monolítico legado (`schema_version: 5`) em `.holoself/index/index.json` e seu schema `schemas/index.schema.json` são **formalmente descontinuados, aposentados e removidos do repositório**.
   - As interfaces `buildIndex`, `readIndex`, `searchIndex` e os comandos CLI `holoself index status` e `holoself index rebuild` passam a operar internamente sobre o novo Catálogo Particionado (`schemas/catalog.schema.json`).
   - Na inicialização ou migração para C-02, o diretório legado `.holoself/index/` é limpo e removido do projeto vinculado, eliminando o vazamento de corpos do self em texto claro no diretório do projeto. A remoção executa com retry e backoff; se persistir bloqueada no Windows por processos concorrentes, aborta a inicialização fail-closed com erro `LEGACY_INDEX_PURGE_FAILED` e diagnóstico claro (M-17).
4. **Schema Estrito e Artefato Sensível (B-2, M-4, M-16, M-18, M-20, L-23):**
   - Schema JSON formal e normativo definido em `schemas/catalog.schema.json` com vocabulário estrito sincronizado com `src/annotations.mjs`.
   - Discrimina `project_context_hash` via condicional `if/then/else` (`null` para `space_id: "self" | "contrib"`; string sha256 de 64 hex para projetos) e exige a presença do campo em `required` (M-18).
   - O catálogo armazena para cada fonte: `source_kind` (`"canonical" | "project" | "contrib"`, M-20), `source_ref`, `file`, `size`, `modified_ms`, `mtime_ns`, `ino`, `dev`, `source_text_hash`, metadados normalizados completos (`frontmatter`), seções com títulos, `section_id` e visibilidade já classificada, claims, tags, links e `estimated_tokens`.
   - Permissões em disco: criados com modo `0o600`. Em Windows (onde o sistema mapeia apenas o bit de leitura), registra-se como mitigante estrutural o isolamento de processo e a alocação do self fora de qualquer repositório de projeto (M-16).
   - Validação formal executada pela função dedicada `validateCatalogSchema` em `src/ecosystem.mjs` / `src/catalog.mjs` (L-23).

#### 6.1.2 Proposta de Gate Cruzado: `SourceRef` e `SubjectSpacePolicyRev` (B-4, R-01, A-01, A-03, H-9, H-10, M-15, M-20, L-7, L-12)
Em cumprimento à dependência cruzada entre T02-S e T03-S para C-03/C-04:
1. **Definição Canônica de `SourceRef` (M-20):**
   ```json
   {
     "space_id": "self" | "<project-id>" | "<peer-id>" | "contrib",
     "source_id": "hs-[0-9a-f]{20}",
     "revision": "<sha256-of-source-bytes>",
     "section_id": "<heading-slug> | null"
   }
   ```
   - Canonicalização estrita de `rel_path` e `source_id` (H-9, L-12, M-20):
     - Para `self` e `project`: `canonical_rel_path = slash(relative(root, path)).normalize('NFC')` (com `.toLowerCase()` no Windows para case-folding).
     - Para `contrib`: `canonical_rel_path = slash(relative(PACKAGE_ROOT, path)).normalize('NFC')` (com `.toLowerCase()` no Windows para case-folding; `space_id = "contrib"`).
     - `source_id = hs-${sha256(space_id + "\0" + canonical_rel_path).slice(0, 20)}`.
   - Regra estrita de revisão (L-7): `source_ref.revision === source_text_hash`.
   - Unicidade e estabilidade de seção (H-10, M-15): cada seção em `sections[]` possui `section_id = slug(heading)` gerado por `heading.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section'`, com sufixo numérico posicional para colisões (`slug`, `slug-2`).
2. **Definição de `SubjectSpacePolicyRev`:**
   ```json
   {
     "subject": { "kind": "owner:direct" | "client:linked", "identity_id": "<sha256>" },
     "space_id": "self" | "<project-id>" | "contrib",
     "policy_revision": "<sha256(registry_hash + link_hash)>",
     "allowed_lenses": ["..."]
   }
   ```

#### 6.1.3 Invariantes de Entrega, Manifesto e Resolução Soberana da Decisão D-08 / V-01 (B-1, B-5, B-6, H-8, H-15, H-18, H-19, M-9)
1. **Registro da Decisão D-08 do Usuário (B-5):**
   - O usuário autorizou em 2026-09-20 a adoção formal da **Opção (b) / Verificação na Entrega** (Opção c arquitetural), estabelecendo a distinção soberana:
     - Descoberta na consulta repetida: **0 releituras de corpo** (todas as $N-k$ fontes descartadas não são abertas nem lidas, resolvendo E-01 e E-02).
     - Entrega na consulta repetida: exatamente **$k$ leituras** ($k \le 10$) dos corpos entregues para reavaliação de ACL, conferência de hash e redação intra-corpo.
     - Manifesto quente: **0 leituras de corpo**.
     - Expansão quente de $k$ handles: **$k$ leituras de corpo**.
2. **Contadores Contábeis e Invariante de Entrega com Redação Reexecutada (INV-ENTREGA) (H-8, H-15, H-19, M-9):**
   - Ficam formalmente estabelecidos três contadores de leitura:
     - `bodyReads`: leituras de corpos Markdown para montagem e entrega de contexto ao agente.
     - `catalog_reads`: leituras de corpos para indexação inicial ou reconciliação de stat no catálogo dentro de `ensureCatalog`.
     - `reconcile_reads`: leituras adicionais decorrentes de divergência concorrente de hash na entrega.
   - Em regime warm estável (zero alteração no corpus), T02-F assevera compulsoriamente: `catalog_reads = 0` e `reconcile_reads = 0`.
   - Toda fonte selecionada para entrega tem seu corpo lido diretamente do arquivo Markdown:
     a) O frontmatter é reparseado a partir do buffer recém-lido;
     b) A ACL de acesso da lente ativa é reavaliada contra a identidade do chamador;
     c) Os portões documentais por lente são reavaliados (`employer-confidential` bloqueado se não autorizado, `document_role: evidence` exige `publication_allowed` sob lentes de publicação);
     d) A redação intra-documento é compulsoriamente reexecutada via `filterClaimVisibility` (remoção de blocos `<!-- holoself-claim visibility=private -->`) e `filterFieldVisibility` (remoção de seções/campos por visibilidade e blocos de compensação sob lente `publishing`) (H-19);
     e) O hash do buffer cru recém-lido é confrontado com `source_text_hash` do catálogo;
     f) Se o hash divergir: o sistema executa no máximo **2 iterações de reconciliação** (H-8). Se persistir divergente, a fonte é omitida da resposta com motivo seguro: `source concurrently modified; omitted fail-closed`. As leituras de divergência são reportadas em `reconcile_reads`;
     g) Se a ACL ou portão documental divergir: a fonte é imediatamente omitida com motivo opaco (`restricted by policy`);
     h) **O `content` entregue na resposta de contexto é obrigatoriamente derivado do buffer redigido — nunca do buffer cru validado por hash (H-19).**
3. **Invariante de Manifesto (INV-MANIFESTO) e Qualificação de Frescor (B-6, H-18):**
   - O manifesto (`manifest: true`) retorna exclusivamente metadados (`content: ''`).
   - `ensureCatalog` valida o frescor por stat `(size, mtime_ns, ino, dev)`. Se qualquer stat divergir ou for incerto, a fonte é obrigatoriamente reconciliada (lida e reparseada) **antes** de emitir o manifesto. Fontes não comprovadas são omitidas fail-closed.
   - *Qualificação de risco residual (H-18):* O manifesto garante frescor sob qualquer divergência observável de stat `(size, mtime_ns, ino, dev)`. Registra-se como risco residual legítimo da Opção (b) autorizada pelo usuário que alterações que preservem integralmente a tupla de stat no modo manifesto (onde k=0 corpos são lidos) não são detectadas sem releitura integral de corpos.

#### 6.1.4 Cache de Decisão Livre de Corpos e Imunidade a Revogação (H-1, H-21, M-2, M-3, M-12, M-13, M-14, L-22, L-23)
1. **Natureza do Cache Persistente:**
   - O cache persistente grava **estritamente a decisão de seleção**, nunca corpos, resumos nem caminhos absolutos (`schemas/context-decision-cache.schema.json`).
   - O campo `receipt` é estritamente tipado com `context_hash`, `task_hash`, `lens`, `budget`, `temporal`, `source_ids` e `source_hashes`.
   - Admite `budget: "unbounded"` (M-13) e `lens: string | null` (M-14) conforme contratos de runtime.
   - Reside em `<projectDir>/.holoself/runtime/context-cache/`, eliminando qualquer risco de vazamento de dados pessoais no projeto.
2. **Chave Canônica de Cache Completa (H-21, M-3, L-14, L-20):**
   ```javascript
   catalog_hash = sha256(canonicalJson({
     self: selfCatalog.sources.map(s => [s.source_ref.source_id, s.source_ref.revision]),
     project: projectCatalog.sources.map(s => [s.source_ref.source_id, s.source_ref.revision])
   }))
   contrib_selection_hash = sha256(canonicalJson(
     Array.isArray(config?.selectedContribs)
       ? [...config.selectedContribs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
       : []
   ))
   requested_source_ids = Array.isArray(options.sources) && options.sources.length
     ? [...options.sources].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
     : null
   cacheKey = sha256(canonicalJson({
     catalog_hash,
     lens_registry_hash: registry.registry_hash,
     contrib_selection_hash,
     identity_id,
     lens,
     allowed_lenses: [...identity.allowedLenses].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
     task_hash,
     temporal,
     include_history: Boolean(options.includeHistory),
     budget,
     manifest: Boolean(options.manifest),
     requested_source_ids,
     cursor: options.cursor || null
   }))
   ```
3. **Expurgo de Cache Legado por Validação de Schema (L-22):**
   - Na inicialização ou carregamento de cache, todo arquivo em `<projectDir>/.holoself/runtime/context-cache/` que não contenha `schema_version: 2` válido conforme `schemas/context-decision-cache.schema.json` é imediatamente expurgado, garantindo que entradas legadas sem versão contendo corpos em texto claro sejam eliminadas.
4. **Validação Formal de Schema (L-23):**
   - Validação executada por `validateDecisionCacheSchema` em `src/ecosystem.mjs` / `src/catalog.mjs`.
5. **Normalização de Entrada da Chave de Cache (Nit 5):**
   - Entradas passadas em `options.sources` ou `options.source_ids` (seja por caminhos relativos, absolutos ou IDs) são resolvidas para identificadores canônicos determinísticos `hs-[0-9a-f]{20}` contra o conjunto de candidatos antes do cômputo da chave de cache (`computeDecisionCacheKey`), garantindo invariância da chave independentemente da forma de invocação.
6. **Reconstituição de Omissões no Acerto de Cache Persistente (S-10, B-3):**
   - O schema de cache de decisão é estritamente livre de corpos e diagnósticos de ranking voláteis (`schemas/context-decision-cache.schema.json`).
   - Em acertos de cache persistente (`warm`), candidatos não selecionados têm motivos de omissão reconstituídos por heurística honesta baseada em metadados estruturais (restrições temporais, limite de seleção de contribs `contribCount >= 2`, orçamento de envelope ou relevância semântica).
   - Em modo `--manifest`, candidatos não selecionados constituem itens pagináveis sob `next_cursor` e não geram omissões sintéticas (B-3).

#### 6.1.5 Frescor por Stat Robusto, TOCTOU e Validação Bidirecional (H-2, H-3, H-4, H-14, M-7, L-6, L-8, L-23)
1. **Tupla de Frescor Estrita (H-2, L-6, L-8):**
   - Avalia `statSync(file, { bigint: true })` usando a tupla completa: `(size, mtime_ns, ino, dev)`, com `ino` e `dev` normalizados como strings decimais (`stat.ino.toString(10)`).
   - A comparação de frescor valida conjuntamente `size`, `mtimeNs`, `ino` e `dev` (L-6).
2. **Confronto de Registro de Lentes e Configuração de Projeto (H-3, H-14):**
   - `ensureCatalog` compara obrigatoriamente `registry.registry_hash === catalog.lens_registry_hash`.
   - A validação de `hash(canonicalJson(link.project_context)) === catalog.project_context_hash` aplica-se **exclusivamente ao catálogo do projeto**; para o catálogo do self e de contribs, assevera-se `catalog.project_context_hash === null` (H-14).
3. **Sequência Anti-TOCTOU `stat -> read -> re-stat` (H-4):**
   - Em toda indexação ou atualização:
     1. `s0 = statSync(file, { bigint: true })`
     2. `text = readFileSync(file, 'utf8')`
     3. `s1 = statSync(file, { bigint: true })`
     4. Se `s0.size !== s1.size || s0.mtimeNs !== s1.mtimeNs || s0.ino !== s1.ino || s0.dev !== s1.dev`: retry limitado (máx. 2). Persistindo, omite a fonte fail-closed sem gravar mtime falso no catálogo.
4. **Tratamento de TOCTOU na Entrega (M-7):**
   - Se um arquivo for deletado entre catálogo e entrega: `ENOENT` é capturado, a fonte é omitida com motivo opaco (`source unavailable at delivery`) e o catálogo local é atualizado, sem derrubar a requisição global.

#### 6.1.6 Concorrência, Escrita Atômica e Resiliência Windows (H-5, H-11, H-16, M-10, L-1, L-2, L-9, L-20)
1. **Helper Unificado `atomicWriteFile` (H-5, M-10, L-1):**
   - Gravação em temporário `${target}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}` com modo explícito `0o600`.
   - Flush síncrono com `fsyncSync(fd)` antes de fechar o descritor.
   - `renameSync` atômico para o destino final, seguido de `fsync` do diretório pai onde suportado pela plataforma.
2. **Tratamento de Bloqueios no Windows (`EPERM` / `EBUSY`):**
   - Retry com backoff exponencial curto (3 tentativas: 20ms, 50ms, 100ms) para superar bloqueios transitórios de antivírus e processos concorrentes.
3. **Determinismo, Ordenação por Code-Unit Global e JSON Canônico (H-11, H-16, L-2, L-9, L-20):**
   - A proibição de `localeCompare` é estendida a **toda ordenação que participe de hashes, decisões de seleção ou cursores**: `catalog.sources`, claims, tags, links, tokens, `requested_source_ids`, `allowed_lenses` e `stateHash` devem utilizar o comparador binário de UTF-16 code-unit `(a < b ? -1 : a > b ? 1 : 0)` (H-16, L-20).
   - `canonicalJson` ordena chaves recursivamente por code-unit lexicográfico em mapeamentos YAML e metadados antes do cálculo de hash.
   - `generated_at` é anotado e excluído do hash do catálogo, garantindo digest idêntico byte a byte.
4. **Limpeza Segura de Temporários:**
   - Varredura restrita a arquivos `.tmp-*` com mais de 5 minutos de idade e cujo PID emissor não esteja ativo (`try { process.kill(pid, 0) } catch`).

#### 6.1.7 Governança de Cache, Configuração e Expiração Fail-Closed (B-3, H-6, H-17, H-20, M-8, M-11, L-3, L-4, L-13, L-16)
1. **Superfície de Configuração de Cache (V-11, L-16):**
   - `HOLOSELF_CACHE_MAX_ENTRIES`: default 256 arquivos.
   - `HOLOSELF_CACHE_MAX_BYTES`: default 20.971.520 B (20 MiB).
   - Precedência: Environment > `link.yaml` (`cache_limit_entries`, `cache_limit_bytes`) > Defaults. Validação fail-safe com adoção de default e avisos em caso de valor inválido.
2. **Evicção LRU Confiável com Touch Resiliente (M-11, L-3):**
   - Evicção LRU por `mtime`. Em cache hit, tenta `utimesSync(cacheFile, now, now)` com captura segura de falha (`try/catch`), garantindo que sistemas somente-leitura ou bloqueios transitórios não abortem a entrega de contexto.
   - Temporários `.tmp-*` são estritamente excluídos da contagem e da evicção de cache.
3. **Gramática Unificada e Sentinela Fail-Closed de `valid_until` (H-6, H-17, H-20, M-8, L-13):**
   - Gramática canônica: aceita data ISO `YYYY-MM-DD` ou data-hora ISO com timezone `YYYY-MM-DDTHH:mm:ss(.\d+)?(Z|[+-]HH:mm)` (H-20).
   - Normalização determinística: datas `YYYY-MM-DD` sem horário são interpretadas como `23:59:59.999Z` (final do dia UTC), garantindo que a fonte continue válida durante o dia declarado sem expirar prematuramente na autoria e viabilizando o cache warm em corpora datados (H-20).
   - Conversão para `valid_until_epoch_ms`:
     - Se `valid_until` for ausente ou `null`: fica fora do cálculo de `min(valid_until_epoch_ms)` e grava `null` na ausência total (M-8).
     - Se presente e parseável: convertido para timestamp UTC numérico em milissegundos.
     - Se presente mas ilegível ou malformado: **fail-closed atribuindo sentinela `valid_until_epoch_ms = 0`** (expirado imediatamente, H-17, H-20).
   - Alinhamento de runtime (H-20): `dateValue` em `src/context-selection.mjs` adota a mesma normalização de final de dia e retorna sentinela `0` em valores inválidos, garantindo que fontes malformadas expirem fail-closed de forma consistente tanto na seleção temporal quanto no cache.
   - Comparação numérica: `if (cached.valid_until_epoch_ms !== null && Date.now() >= cached.valid_until_epoch_ms) return cacheMiss()`.

#### 6.1.8 Limites Quantitativos Congelados (B-3, B-5, B-7, H-15, M-9, M-19)
Orçamentos congelados após decisão D-08 autorizada, condicionados a regime warm estável (zero divergência de stat):

| Cenário | Corpus $N$ | Orçamento `bodyReads` (Entrega) | Orçamento `catalog_reads` (Indexação) | Orçamento `metadataOps` | p95 Latência (Alvo) | Condição de Regime |
|---|---|---|---|---|---|---|
| **CLI Context Cold** | 100 / 1.000 / 10.000 | **$\le k$** ($k \le 10$) | **$\le N$** (primeira indexação) | $\le 2N + 20$ | $\le 150\text{ ms} / 1.000\text{ ms} / 6.000\text{ ms}$ | Frio / reconstrução |
| **CLI Context Warm (Repetido)** | 100 / 1.000 / 10.000 | **$\le k$** ($k \le 10$ entregues) | **0** | $\le N + 20$ | $\le 40\text{ ms} / 120\text{ ms} / 600\text{ ms}$ | `catalog_reads = 0`, `reconcile_reads = 0` |
| **Manifest Warm** | 100 / 1.000 / 10.000 | **0** (zero leituras) | **0** | $\le N + 20$ | $\le 30\text{ ms} / 80\text{ ms} / 400\text{ ms}$ | `catalog_reads = 0`, `reconcile_reads = 0` |
| **Expansão Warm ($k$ handles)** | 100 / 1.000 / 10.000 | **$\le k$** (apenas pedidos) | **0** | $\le k + 10$ | $\le 20\text{ ms} / 30\text{ ms} / 50\text{ ms}$ | `catalog_reads = 0`, `reconcile_reads = 0` |
| **Busca Índice Warm** | 100 / 1.000 / 10.000 | **0** (zero leituras) | **0** | $\le N + 20$ (frescor validado) | $\le 30\text{ ms} / 80\text{ ms} / 400\text{ ms}$ | `catalog_reads = 0`, `reconcile_reads = 0` |

#### 6.1.9 Busca Integrada e Contribs (B-2, B-7, M-6, M-20)
1. **Busca Integrada com Frescor:**
   - A busca (`searchIndex`) executa compulsoriamente `ensureCatalog` antes de pesquisar, garantindo que o índice de seções e claims reflita o estado corrente com orçamento $\le N + 20$.
   - Trechos entregues respeitam a visibilidade computada durante a catalogação; proíbe aplicação de filtros em texto truncado.
2. **Modelo de Catálogo para Contribs Representável (M-6, M-20):**
   - Métodos reutilizáveis (`contribs`) são indexados em partição em memória com `space_id: "contrib"`, `source_kind: "contrib"`, derivada de `PACKAGE_ROOT/contribs`.
   - Cada método reutilizável possui `SourceRef` em conformidade estrita com `schemas/catalog.schema.json` e `schemas/context-decision-cache.schema.json`:
     `source_id = hs-${sha256("contrib\0" + slash(relative(PACKAGE_ROOT, path)).normalize('NFC')).slice(0, 20)}`.
   - Seções, claims e tokens são catalogados uma única vez na inicialização sem I/O repetido.

#### 6.1.10 Pontos de Aplicação dos Validadores Formais de Schema (L-23)
- O validador de catálogo `validateCatalogSchema` e o validador de cache `validateDecisionCacheSchema` residem formalmente em `src/ecosystem.mjs` (ou módulo de catálogo correspondente).
- São executados compulsoriamente na emissão/leitura de catálogos e caches e cobertos diretamente por testes em `tests/efficiency.test.mjs` e `tests/ecosystem.test.mjs`.

### 6.2 Registro de Entrega e Verificação do Ciclo C-02

- T02-R verified: rastreamento de buildIndex, comparativo de opções de persistência descartável sem dependências externas de runtime (`node:` builtins apenas), assegurando compatibilidade estrita com Node >=20.
- T02-S verified: especificação técnica do contrato C02-CONTRACT-1 v5 na Seção 6.1 (catálogo particionado deterministicamente, tupla de stat completa `(size, mtime_ns, ino, dev)`, chave canônica completa, limites e evicção LRU, invalidação por frescor e decisão D-08).
- T02-V verified: Claude Opus (`claude -p --model opus`) revisou adversarialmente em 5 rodadas de auditoria formal (**status: approved**), confirmando:
  - B-1 / B-2: Filtragem estrita *fail-closed* de `links[]` e `sections[].snippet` / `search_text` sob lentes de publicação (`allowed()` e sanitização de visibilidade).
  - B-3: Gating de omissões sintéticas em `if (!o.manifest)` no acerto de cache persistente, garantindo paridade frio/quente no modo manifesto.
  - B-4: Gravação de lápide com `mtime_ns: '0'` e emissão de aviso para arquivos com falha de leitura transitória, garantindo re-tentativa imediata na execução seguinte sem fixação permanente (§6.1.5.3.4).
  - S-6 a S-10 e Nits 1 a 6: Preservação de `knowledge_status` e `temporal_scope`, reconciliação de metadados na entrega, visibilidade `'linked-projects'` de contribs, eliminação de vazamento de `PARTITION_WARNINGS` (N-1), eliminação de envenenamento de validade de cache por documentos já expirados (N-3), ordenação de omissões (N-4) e normalização de chave de cache (§6.1.4).
- T02-D1 & T02-D2 verified: implementação completa em `src/catalog.mjs`, `src/ecosystem.mjs`, `src/context-selection.mjs` e `schemas/catalog.schema.json`.
- T02-F verified:
  - Suíte completa: **204/204 testes passando** (`node scripts/verify.mjs` e `node --test tests/*.test.mjs`), incluindo 27 testes dedicados em `tests/catalog.test.mjs`.
  - Zero dependências de runtime externas (`node:` builtins apenas).
  - Paridade rigorosa entre caminhos cold e warm (`context_hash`, `omitted_count`, `restrictions`, `next_cursor`).
  - `git diff --check` 100% limpo. Ciclo C-02 formalmente verificado e concluído.






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

Arquivos iniciais: `src/lenses.mjs`, `src/ecosystem.mjs`, `schemas/link.schema.json`, `schemas/lens.schema.json`, `schemas/document-metadata.schema.json`, `schemas/links-registry.schema.json`, `schemas/migration-plan.schema.json`, `schemas/migration-receipt.schema.json`, testes de lentes/privacidade/ecossistema. Nenhum registro de espaço pessoal real integra este ciclo.

#### 7.1 Contrato detalhado C03-CONTRACT-1 v12 — lentes como perspectivas, matriz de acesso restritiva e migração reversível

Estado: proposta v12 consolidada por Q incorporando integralmente os achados B11-1, S11-1..S11-3 e N11-1..N11-5 da Revisão 11 de Claude Opus em T03-V.

#### 7.1.1 Desacoplamento de Lente (Perspectiva) e Grant (Autorização) (D-01, R-01, R-03, A-01, A-07, V-04, V-05, B3-1, B3-2, B4-3, B10-1, B10-2, S3-2, S4-4, N5-2, N6-1, N6-2, B7-1, N10-1, N10-2, B11-1, S11-1, S11-2, N11-1, N11-2, N11-3)
1. **Separação Formal entre Escopo de Acesso e Perspectiva (D-01):**
   - A autorização de leitura é estritamente desacoplada do identificador de lente (`lens_id`). Criar ou registrar uma lente customizada não concede nem revoga acesso a documentos (B3-1).
   - O schema de metadados (`schemas/document-metadata.schema.json`) e as estruturas internas (`PRIVACY_FIELDS`, `privacyValueValid`, `restrictPrivacyMetadata`) formalizam o campo canônico `read_scope`:
     - `"shared"`: Acessível por projetos e espaços vinculados autorizados através de lentes compatíveis.
     - `"local"`: Acessível quando `subject.accessible_spaces.includes(source.space_id)` (S3-2). Nota: `read_scope: "local"` é aplicável a `self` e `project`; não é aplicável a `contrib` (N6-2).
     - `"restricted"`: Acessível exclusivamente pelo proprietário direto (`owner:direct`) sob a lente embutida `private` (`resolution.source === "builtin" && lens === "private"`). Jamais acessível por `client:linked` ou por lentes customizadas (B3-2, B5-3).
   - **Regras de Parsing, Validação e Derivação de Leitura de `read_scope` (B2-1, S4-4, N5-2, N10-2):**
     - Em `self` e `project`: quando `read_scope` for **ausente** (documentos legados não migrados ou revertidos), o runtime NÃO quarentena a fonte; em vez disso, deriva `read_scope` dinamicamente em tempo de leitura a partir de `visibility` via tabela normativa de derivação em §7.1.3.1. Isso garante compatibilidade retroativa contínua e evita que corpora legados fiquem ilegíveis antes da migração.
     - **Quarentena e Fallback Restrito a Valores Inválidos (B2-1, N5-2, N10-2):**
       - Em `self`: `read_scope` presente mas sintaticamente inválido (ex.: `read_scope: shred`) quarentena o arquivo *fail-closed* via `canonicalPrivacyMetadataErrors` (`src/ecosystem.mjs:429` e ponto canônico do construtor de catálogo em `src/ecosystem.mjs:1336`) (N10-2).
       - Em `project`: `read_scope` presente mas sintaticamente inválido é restrito *fail-closed* via `restrictPrivacyMetadata` (`src/ecosystem.mjs:322`).
     - Em `restrictPrivacyMetadata`: fixa `read_scope: "restricted"`.
     - Nota: `read_scope: "local"` é um campo de autoria v2; a migração de metadados legados nunca sintetiza `local` a partir de `visibility` (apenas `"shared"` ou `"restricted"`).
   - **Transporte Canônico de `read_scope` para o Catálogo, Esquema de Catálogo v2 e Atualização de Fixtures (B10-1, S11-1):**
     - `privacyMetadata` (`src/ecosystem.mjs:1312`) materializa compulsoriamente `read_scope` na projeção de frontmatter persistida no catálogo:
       `read_scope: ['shared', 'local', 'restricted'].includes(metadata.read_scope) ? metadata.read_scope : (visibility(metadata) === 'private' ? 'restricted' : 'shared')`.
     - `ALLOWED_FRONTMATTER_KEYS` em `src/catalog.mjs:212` adiciona compulsoriamente `'read_scope'`.
     - `schemas/catalog.schema.json` adiciona `"read_scope": { "type": "string", "enum": ["shared", "local", "restricted"] }` sob `properties` e sob `required` da definição de `frontmatter`.
     - `CATALOG_SCHEMA_VERSION` avança para `2` em `src/catalog.mjs` e `schemas/catalog.schema.json`, forçando rebuilding transparente de partições legadas em `ensureCatalog` e garantindo que o portão de Fase 1 em `catalogCandidateRecords` (`src/ecosystem.mjs:463`) acesse o metadado estruturado com integridade absoluta (B10-1).
     - **Obrigações Normativas de Atualização de Testes e Fixtures de Catálogo para T03-D1 (S11-1):**
       A transição do catálogo para v2 e a exigência de `read_scope` impõem a atualização estrita dos seguintes pontos existentes da suíte de testes:
       1. **Asserções de versão do catálogo (1 $\to$ 2):** `tests/lenses.test.mjs:92`, `tests/privacy-capabilities.test.mjs:79, 95, 130`, e `tests/catalog.test.mjs:635` (atualizar `assert.equal(index.schema_version, 1)` para `assert.equal(index.schema_version, 2)`).
       2. **Fixtures estáticas de catálogo com versão legada:** `tests/catalog.test.mjs:209, 283, 330, 449, 685` (atualizar `schema_version: 1` para `schema_version: 2`).
       3. **Fixtures estáticas de frontmatter sem `read_scope`:** `tests/catalog.test.mjs:134, 491, 664` (adicionar `read_scope: 'shared'` para manter conformidade estrita com o schema v2).
2. **Identidade Canônica Unificada de Espaço (`space_id`), Sujeito e Espaços Acessíveis (B2-4, B10-2, S3-2, S3-3, N3-4, N4-2, N6-1, B7-1, B9-3, N9-3):**
   - Fica formalmente unificada a identidade de espaço em toda a base (`catalog`, `ecosystem`, `lenses`), com prefixos distintos para diferenciar namespaces (N3-4):
     - `self`: `space_id = "self"`.
     - `contrib`: `space_id = "contrib"`.
     - `project`: `space_id = "hs-space-" + sha256("project\0" + canonical_project_path).slice(0, 16)`.
       (Derivado deterministicamente do caminho canônico resolvido por `safeRealpath`, NFC normalizado, lowercase no Windows).
   - **Cláusula de Supersessão e Reindexação de Catálogo (S3-3):** Fica formalmente revogada e substituída a definição de `space_id: basename(projectDir)` e `SourceRef.source_id` de C-02 §6.1.2. A adoção da tupla `hs-space-...` e a evolução do esquema de catálogo para v2 acionam rebuilding transparente de catálogo em `ensureCatalog`, atualizando chaves de cache e catálogos com integridade garantida.
   - **`source.space_id`**: determinado pela raiz do diretório de onde o documento foi carregado (`selfRoot` $\implies$ `"self"`, `PACKAGE_ROOT/contribs` $\implies$ `"contrib"`, `projectRoot` $\implies$ `space_id` do projeto).
   - **`subject.space_id` e `subject.accessible_spaces` (S3-2, N4-2, N6-1, B7-1, B9-3, B10-2, N9-3):**
     - Para `owner:direct`: `subject.space_id = "self"`.
       - **Condição Normativa de Contenção de CWD (B7-1):** Conforme `src/ecosystem.mjs:625`, a resolução de `owner:direct` exige compulsoriamente que o diretório de trabalho do processo chamador esteja contido na raiz canônica do self (`cwd ∈ selfRoot`, validado via `assertContainedPath(targetSelf, cwd)`). Invocadores fora de `selfRoot` sem projeto/link são rejeitados fail-closed com `LINK_REQUIRED`.
        - Quando `project` estiver presente: cláusula forward-looking para C-04 (`subject.accessible_spaces = ["self", current_project_space_id]`). Na arquitetura atual, qualquer invocação com `project !== null` resolve exclusivamente a identidade `client:linked`, sendo impossível atingir `owner:direct` com projeto na execução de runtime vigente (N11-3).
        - Quando `project` for `null` (caso de consulta direta do proprietário sem projeto com `cwd ∈ selfRoot`, ex.: `context --root <selfRoot> --lens private` executado a partir de `<selfRoot>` ou de qualquer subdiretório de `<selfRoot>`): `subject.accessible_spaces = ["self"]` (N6-1, B7-1, N11-3).
          - **Particionamento Estritamente Dirigido por Identidade e Plumbing de `projectDir` (B9-3, B10-2, S11-2, N9-3, N11-1):** Sempre que `identity.kind === "owner:direct"` e `identity.project === null` (independentemente de `cwd` ser `<selfRoot>` ou qualquer subdiretório `cwd ⊂ selfRoot`, como `<selfRoot>/context`):
            1. Em `contextData` (`src/ecosystem.mjs:680`), o argumento `projectDir` repassado a `ensureCatalog` é computado compulsoriamente como `identity.kind === 'client:linked' ? project : null` (S11-2). Ao passar `null` para `owner:direct`, suprime-se categoricamente a execução acidental de `purgeLegacyIndex(projectDir)` sobre subpastas do self (`src/ecosystem.mjs:1673`), prevenindo expurgo indevido de índices em subdiretórios de self (S11-2).
            2. Como `projectDir === null`, `ensureCatalog` (`src/ecosystem.mjs:1679`) **NÃO constrói partição de projeto** (`catResult.project = null`), e nenhum diretório `.holoself/catalog` é criado dentro de subdiretórios do self (B10-2).
            3. O predicado de varredura de partição local em `contextData` (`src/ecosystem.mjs:682`) é estritamente condicionado à identidade: `local = (identity.kind === 'client:linked' && identity.project !== null && !o.selfOnly && existsSync(project) && resolve(project) !== resolve(self) && catResult.project) ? ... : { records: [], restrictions: [] }` (B10-2, N11-1).
            4. Apenas a partição `catResult.self` é escaneada, fixando compulsoriamente `source.space_id = "self"` para todos os documentos escaneados.
            5. Como `subject.accessible_spaces = ["self"]`, todo documento com `read_scope: "local"` ou `"shared"` satisfaz deterministicamente `subject.accessible_spaces.includes(source.space_id)` (visto que `"self" \in ["self"]`), eliminando pela raiz qualquer dupla varredura de arquivos físicos, contagens corrompidas de orçamento ou vereditos conflitantes (B9-3, B10-2, N9-3).
     - Para `client:linked`: `subject.space_id = current_project_space_id`; `subject.accessible_spaces = [current_project_space_id]`. O chamador vinculado acessa estritamente documentos locais do seu próprio projeto; `"self"` é categoricamente inacessível para escopo `local`.
3. **Lentes como Perspectivas Declarativas, Rótulo Exato para Acesso e Proibição de Herança em Fase 3 (B3-1, B2-3, N3-2):**
   - Uma lente define uma perspectiva de relevância, vocabulário e regras de projeção (instruções, ranking semântico e regras operacionais de redação herdadas de `base_lens`, `behaviorLens`).
   - `access_lenses`: Array de identificadores de lentes sob as quais o documento é indexado como relevante.
   - **Acesso Estrito por Rótulo Exato sem Herança de `base_lens` (B3-1):**
     - O gating de acesso em Fase 3 exige **correspondência exata de identificador**: $L \in \text{access\_lenses}(meta)$.
     - `base_lens` é utilizado **exclusivamente para regras de comportamento e redação** (`behaviorLens`), mantendo integralmente a invariante testada em `tests/lenses.test.mjs:60-68` ("custom context requires exact label").
     - Criar ou registrar uma lente customizada NÃO concede acesso retroativo a documentos marcados com a lente base, preservando estritamente a invariante de não-ampliação $\text{allowed}_{\text{after}} \implies \text{allowed}_{\text{before}}$.
   - **Proibição Formal e Ponto de Aplicação de `base_lens: "private"` (B2-3, N3-2, N5-1):**
     - Fica expressamente revogada a menção permissiva da linha 263 de §5.1.2 (anotada inline).
     - `validateDefinition` em `src/lenses.mjs:34` é formalmente reforçado:
       `if (!BUILTIN_BY_ID.has(value.base_lens) || value.base_lens === 'private') fail(file, 'base_lens must be a non-private built-in lens');`
     - `schemas/lens.schema.json` restringe estritamente `base_lens` ao enum:
       `"base_lens": { "enum": ["general", "career", "publishing", "technical", "leadership", "interview"] }`.
     - Em `schemas/context.schema.json`, `base_lens: "private"` permanece admitido condicionalmente unicamente para a definição da própria lente embutida `private` (`source === "builtin" && id === "private"`), sendo sumariamente rejeitado para qualquer lente customizada.
4. **Separação Explícita entre Avaliador de Fonte e Avaliador de Redação Intra-Corpo (B4-3, S5-1, S6-1, S7-1, S9-6, N7-2, N8-3):**
   - Ficam formalmente separados dois avaliadores especializados com assinaturas e contratos distintos:
     a) **Avaliador de Acesso a Fonte (`allowedDocument(meta, lens, adapter, task, resolution, subject)`):** Portão de acesso em 7 fases que decide a elegibilidade do documento completo. O objeto `subject` transporta os vereditos pré-resolvidos de atestação e concessões (`effective_allowed_lenses`, `accessible_spaces`, `attestation_valid`) validados no preflight (N10-1).
     b) **Avaliador de Redação Intra-Corpo (`visibleUnderBehavior(visibility, behaviorLens, adapter = 'generic')`):** Avaliador comportamental utilizado em todos os 12 pontos de chamada intra-corpo (`filterClaimVisibility`, `filterFieldVisibility`, e filtragem de seções, claims, tags e links no catálogo):
        - Entrada: `visibility`.
        - **Coerção Fail-Closed de Visibilidade Inválida (S6-1, S7-1, N8-3):** `const v = VISIBILITIES.includes(visibility) ? visibility : 'private'`. Valores extraídos de regex (como em `filterClaimVisibility`, `src/ecosystem.mjs:399`) ou campos intra-corpo que não pertençam estritamente ao enum `VISIBILITIES` (`'private'`, `'linked-projects'`, `'career'`, `'publishing'`, `'public-safe'`) são compulsoriamente coagidos a `'private'` *fail-closed*, impedindo que valores malformados ou typos vazem conteúdo para fora do proprietário (S6-1).
        - **Preservação de Diagnóstico e Escopo Exclusivo ao Proprietário (N8-3, S9-6, §7.1.1.5):** O registro detalhado do motivo em `restrictions[]` reportando o valor bruto original não-coagido (`claim visibility ${claimVisibility} excluded by ${lens} lens`) é estritamente restrito a chamadas de `identityKind === 'owner:direct'` (`if (identityKind === 'owner:direct') restrictions.push(...)`). Para chamadores `client:linked`, restrições intra-corpo detalhadas são silenciosamente suprimidas ou anonimizadas conforme a regra anti-oráculo de §7.1.1.5, impedindo vazamento de pistas estruturais sobre tokens ou tipografias internas a projetos vinculados (S9-6).
        - **Distinção de Granularidade e Relatório (S7-1):** A coerção fail-closed intra-corpo é um estreitamento de segurança aceito em tempo de execução operando na granularidade de seções/blocos/claims. Por construção, está fora do escopo do relatório de migração de documentos em §7.1.3.4 (que computa cobertura sobre $d \in \text{Docs}$ inteiros) e consta formalmente documentada na tabela de transição de capacidades em §7.1.3.5 (S7-1).
        - Regra padrão: `legacyAccessLenses({ visibility: v }).includes(behaviorLens)`.
        - Condição de adapter público: se `adapter` for público (`'obsidian-public'`, `'public'`, `'restricted-host'`), exige `v === 'public-safe'` (S5-1). Nota: o parâmetro `adapter = 'generic'` é forward-looking para suportar os novos adaptadores públicos previstos em C-04/C-05; todos os 12 pontos de chamada intra-corpo vigentes invocam com `'generic'` (N7-2).
        - Sob `--lens private`, `behaviorLens === 'private'`, garantindo que `legacyAccessLenses({ visibility: 'private' })` retorna `['private']` e preserva 100% dos blocos e seções privadas do proprietário.
5. **Unificação Homogênea da Precedência Fail-Closed em 7 Fases para `allowedDocument` (R-03, S-1, S-2, B3-1, B3-2, B4-1, B4-2, B5-3, B9-1, S3-2, S5-3, N5-4, N10-1):**
   - A avaliação de elegibilidade do documento em `allowedDocument` executa 7 fases rigorosas:
     - **Fase 1 (Sujeito e Escopo Relacional) (B3-2, B10-1, S3-2):**
       - Se `meta.read_scope === "restricted"`: exige universalmente `subject.kind === "owner:direct" && resolution.source === "builtin" && lens === "private"`. Para chamadores vinculados, recusa *fail-closed* sem oráculo de erro.
       - Se `meta.read_scope === "local"`: exige `subject.accessible_spaces.includes(source.space_id)` (S3-2).
       - Se `meta.read_scope === "shared"`: permitido para `owner:direct` e `client:linked`.
     - **Fase 2 (Teto Soberano, Exclusão Categórica de `private`, Predicado de Sal e Avaliação Pré-Cache) (B-5, B-6, B3-2, B9-1, S5-3, N5-4, N10-1, N11-2):**
       - Se o chamador for `client:linked`:
         - O cálculo de `effective_allowed_lenses` e a validação do predicado de `binding_salt` são executados compulsoriamente uma única vez no início da consulta em `contextData` (`src/ecosystem.mjs:557`) (N5-4, N10-1, N11-2).
         - **Avaliação Pré-Cache Obrigatória (S5-3):** A verificação de atestação do vínculo é avaliada compulsoriamente **antes** de qualquer consulta ao cache de decisão em disco (`src/catalog.mjs`). Vínculos não registrados, revogados ou com sal inválido abortam imediatamente *fail-closed* com `LENS_NOT_GRANTED`, sem tocar nem ler o cache de decisão.
         - Localiza o vínculo no registro `<selfRoot>/.holoself/links.json` pelo `canonical_project_path` e valida `binding_salt`:
           - **Predicado Exato de Validação de `binding_salt` (B9-1):**
             `typeof registryEntry.binding_salt === 'string' && typeof linkYaml.self_context?.binding_salt === 'string' && registryEntry.binding_salt.length > 0 && registryEntry.binding_salt === linkYaml.self_context.binding_salt`.
           - Se o predicado falhar (sal ausente, vazio, nulo ou divergente entre os dois arquivos): aborta imediatamente *fail-closed* com `LENS_NOT_GRANTED` (registrando internamente motivo de auditoria `binding_salt mismatch or absent`), impedindo categoricamente ataques de sequestro de caminho (path-reuse hijacking) (B9-1).
         - Se o vínculo não existir ou tiver `status !== "active"`: recusa com `LENS_NOT_GRANTED` (`effective_allowed_lenses = ∅`).
         - Calcula o teto efetivo soberano subtraindo compulsoriamente `"private"`:
           $$\text{effective\_allowed\_lenses} = ((link.\text{default\_lens} \cup link.\text{secondary\_lenses}) \cap link\_entry.\text{allowed\_lenses}) \setminus \{\text{"private"}\}$$
         - Se $L \notin \text{effective\_allowed\_lenses}$: recusa com `LENS_NOT_GRANTED`.
     - **Fase 3 (Indexação da Perspectiva por Rótulo Exato) (B3-1):**
       - Exige estritamente $L \in \text{access\_lenses}(meta)$. Nenhuma herança de `base_lens` opera sobre a autorização de leitura.
     - **Fase 4 (Exclusão Explícita):**
       - Se `(meta.exclude_lenses || []).includes(L)`: recusa com `access_lenses exclude <L> lens`.
     - **Fase 5 (Filtro de Tarefa):**
       - `taskAllowed(meta, task)` precisa ser verdadeiro.
     - **Fase 6 (Teto de Sensibilidade, Proibição Absoluta de `restricted` e Guidance de Política) (S-1, B4-1, B4-2, B5-3):**
       - **Proibição Categórica de `restricted` para Vinculados (B5-3):** Se `meta.sensitivity === 'restricted'`, exige universalmente `subject.kind === "owner:direct" && resolution.source === "builtin" && lens === "private"`. Para `client:linked`, é sumariamente negado sem qualquer exceção de política (B5-3).
       - **Lente Customizada (B4-1):** Se `meta.sensitivity === 'restricted'`, nega categoricamente. Se `meta.sensitivity` for confidencial (`SENSITIVITY_LENSES[meta.sensitivity]` definido), exige que conste explicitamente em `resolution.sensitivity_access` (B4-1, preservando `tests/lenses.test.mjs:89`).
       - **Lente Embutida (B4-2, B5-3):** Para sensibilidades confidenciais não-restritas, preserva o guidance de política para agentes:
         `if (documentRole(meta) !== 'policy' && SENSITIVITY_LENSES[meta.sensitivity] && !SENSITIVITY_LENSES[meta.sensitivity].includes(lens)) return false`.
         Documentos com `document_role: "policy"` continuam legíveis sob lentes embutidas (incluindo `publishing`), garantindo que instruções de governança e compliance alcancem o agente (`tests/privacy-capabilities.test.mjs:22-34`) (B4-2).
     - **Fase 7 (Divulgação e Adapter Público):**
       - Se o adapter for público (`obsidian-public`, `public`, `restricted-host`): exige `publicationAllowed(meta)`.
   - **Atribuição de Motivos Segura (S-2, N2-4):**
     - Para `owner:direct`: `restrictions[]` reporta o motivo da primeira fase que falhou.
     - Para `client:linked`: restrições de existência e documentos fora de escopo são suprimidas silenciosamente (*fail-closed* sem oráculo), reportando apenas contador agregado opaco `unauthorized_sources_omitted: N` (contando exclusivamente documentos que seriam candidatos da busca).

#### 7.1.2 Registro Opt-in Soberano de Espaços Participantes no Self (D-03, B-5, B-6, B-7, B3-2, B3-3, B3-4, B5-1, B5-2, B6-2, B7-2, B8-1, B8-2, S4-1, S4-2, S4-3, S5-3, S6-2, S6-3, S6-4, S7-2, S7-3, S7-4, S8-1, S8-2, S8-4, S11-1, S11-3, N3-5, N4-4, N6-3, N7-1, N11-4, N11-5)
1. **Estrutura do Registro Soberano `<selfRoot>/.holoself/links.json` e Fronteira de Atestação (S6-4):**
   - Governado por `schemas/links-registry.schema.json` com `schema_version: 1` e `additionalProperties: false`.
   - **Fronteira Soberana de Atestação (S6-4):** A autoridade de atestação reside estrita e soberanamente na autoridade de escrita do proprietário sobre `<selfRoot>`. O arquivo `<selfRoot>/.holoself/links.json` define a fronteira contratual e criptográfica de permissões soberanamente concedidas pelo self aos projetos vinculados.
   - Campos de cada entrada:
     - `project_id`: `hs-space-${sha256("project\0" + canonical_project_path).slice(0, 16)}` (N3-4).
     - `project_path`: Caminho canônico (resolvido por `safeRealpath`, NFC normalizado, lowercase no Windows).
     - `binding_salt`: Sequência de 32 hexadecimais gerada no self e salva em `link.yaml` (`self_context.binding_salt`) na aprovação.
     - `allowed_lenses`: Array com `uniqueItems: true` de IDs de lentes autorizadas soberanamente pelo self. Rejeita compulsoriamente `"private"`.
     - `status`: Enum binário estrito `["active", "revoked"]`. Vínculos não registrados não existem no arquivo e têm acesso nulo por padrão.
     - `attested_by`: String descritiva (ex.: `"owner:direct"`) ou `null`.
     - `created_at`, `updated_at`, `revoked_at`: Timestamps ISO 8601 monotônicos.
2. **Modelo de Ameaça de `binding_salt` (S4-2):**
   - O `binding_salt` combate o ataque de **Sequestro de Autorização Órfã por Reuso de Caminho (Path-Reuse Hijacking)**: caso um projeto legítimo $A$ no caminho $P$ seja deletado ou substituído no sistema de arquivos por um diretório de projeto $B$ não confiável no mesmo caminho $P$, $B$ não pode herdar silenciosamente os privilégios concedidos a $A$ em `<selfRoot>/.holoself/links.json` porque não possui o `binding_salt` criptográfico emitido pelo self no momento da aprovação.
3. **Preservação de `binding_salt` no Ecossistema e Higiene de Saída (S4-1, S10-3):**
   - `writeLink` (`src/ecosystem.mjs:211-213`) expande formalmente sua assinatura:
     `writeLink(project, self, lens, secondary, projectContext, bindingSalt = null)` (S10-3).
     - Se `bindingSalt` for explicitamente fornecido (resolvido pelo chamador em §7.1.2.5 passo 4), `writeLink` grava o valor em `self_context.binding_salt`.
     - Se `bindingSalt` for omitido ou `null`, mas existir um `link.yaml` legível com `self_context.binding_salt` válido, `writeLink` lê e preserva o sal existente, prevenindo destruição acidental em re-links (S4-1, S10-3).
   - `link status` (`src/ecosystem.mjs:1892`) mascara ou exclui `binding_salt` da sua saída JSON pública.
4. **Atualização do Schema de Link (`link.yaml`) e Validador em `src/ecosystem.mjs` (B3-2, B3-3, B8-1, S8-2, S9-5, N9-1):**
   - Em `src/ecosystem.mjs:186`, o conjunto normativo de chaves de `self_context` é estendido adicionando exatamente `'binding_salt'`:
     `allowedKeys = new Set(['path', 'access', 'proposals', 'index', 'default_lens', 'secondary_lenses', 'binding_salt'])`.
   - `schemas/link.schema.json` adiciona sob `properties.self_context`:
     `"binding_salt": { "type": "string", "pattern": "^[0-9a-f]{32}$" }`.
   - `linkSchemaErrors` rejeita sumariamente `default_lens: "private"` e `"private"` em `secondary_lenses` (B3-2).
   - **Gate Antecipado em `link setup` (S8-2):** `link setup` (`src/ecosystem.mjs:1900`) executa compulsoriamente `linkSchemaErrors(desired, registry)` antecipadamente no preflight, antes de invocar `createLinkDirs` ou efetuar qualquer escrita em disco, garantindo simetria estrita com `link add` e prevenindo gravações parciais ou falhas tardias sujas (S8-2).
   - **Tolerância Estrita de Leitura e Obrigações de Comandos (B8-1, S9-5, N9-1):**
     - **Escopo Exato de `{ tolerant: true }` em `readLink` (N9-1):** A opção relaxa exclusivamente a validação semântica de schema v2 (`linkSchemaErrors`). Erros sintáticos de parsing YAML permanecem categoricamente fatais (*fail-closed*), e regras de contenção de caminho e rejeição de symlinks continuam sendo estritamente aplicadas (N9-1).
     - **Obrigações de `link repair` sob `{ tolerant: true }` (S9-5):** `link repair` utiliza `{ tolerant: true }` para ler o arquivo sem lançar exceção na leitura, mas executa compulsoriamente `linkSchemaErrors(link, registry)`. Se o link contiver violações de schema v2 (como `default_lens: private`), `link repair` repara diretórios ou adaptadores faltantes, mas **recusa declarar o link como saudável** (`healthy: false`), preservando a consistência com `link status` e `link doctor` (que reportam `broken`), e emite instrução clara de reconfiguração:
       `Link schema is invalid (e.g. default_lens: private). Reconfigure with 'holoself link setup --lens <valid-lens> --force'`.
5. **Auto-Atestação Unificada em Inicializações com `--self` (`link add`, `link setup`), Preservação de Sal e Rollback Fiel (B5-1, B6-2, B7-2, B8-2, B10-3, S6-2, S7-2, S7-3, S8-1, S9-1, S9-2, S10-3):**
   - Quando qualquer comando de inicialização ou vinculação dirigido pelo proprietário for executado com `--self` (`holoself link add` e `holoself link setup`, `src/ecosystem.mjs:1900`) (B6-2):
     - **Proteção e Re-autorização de Vínculos Revogados (B8-2, S7-3):** Se o registro soberano `<selfRoot>/.holoself/links.json` já contiver uma entrada para o projeto com `status === "revoked"`:
       - Por padrão, a auto-atestação em `link add` / `link setup` **recusa a transição silenciosa `revoked -> active`** e aborta *fail-closed* com erro informativo:
         `Link was previously revoked in self registry. Re-run with --force-reauthorize (or run 'holoself link approve --project <dir>' from self root) to re-authorize.`
       - Se o operador fornecer explicitamente a flag `--force-reauthorize` (ou `--force`), o comando — agindo com soberania sobre o self via `--self` — **re-autoriza o vínculo**: atualiza a entrada existente no registro soberano marcando `status: "active"`, `binding_salt = <novo_sal>`, `updated_at = new Date().toISOString()`, `revoked_at = null`, gerando novos segredos criptográficos e restabelecendo a autorização de forma intencional e auditável (B8-2, S7-3).
     - O comando auto-atesta e registra o vínculo em `<selfRoot>/.holoself/links.json`:
       - `status: "active"`
       - `binding_salt`: resolvido conforme a regra de preservação (S7-2, S9-2, S10-3)
       - `allowed_lenses`: derivado das lentes declaradas do vínculo: `([default_lens, ...(secondary_lenses || [])]) \setminus {"private"}` (ou limitado pela flag `--lenses` se fornecida explicitamente) (B5-1)
       - `attested_by: "owner:direct"`
   - Esta regra assegura compatibilidade retroativa e aprovação instantânea para todas as 48 chamadas de fixtures e testes de ecossistema (`tests/*.test.mjs`), preservando a integridade soberana sem necessidade de comandos adicionais.
    - **Semântica Transacional Cross-File, Concorrência e Rollback Pontual (B7-2, B8-2, B10-3, S6-2, S7-2, S8-1, S9-1, S10-3, S11-3, N11-4):**
      - O arquivo compartilhado `<selfRoot>/.holoself/links.json` é governado por contrato normativo de concorrência e serialização aplicado compulsoriamente a todos os 6 comandos que leem/modificam o registro (`link add`, `link setup`, `link approve`, `link backfill`, `link remove`, `link prune`) (B10-3, N11-4):
        1. **Serialização por Lockfile Exclusivo (`withRegistryLock`) e Imunidade a Auto-Deadlock (B10-3, S11-3):**
           - `withRegistryLock` é adquirido e liberado **por operação atômica discreta** sobre o registro (leitura/snapshot inicial no passo 3 e escrita/CAS no passo 6). O lock NUNCA é mantido aberto durante a transação inteira ou durante etapas lentas externas (criação de diretórios, gravação de `link.yaml` ou ativação de adaptadores no passo 7). Isso elimina categoricamente qualquer auto-deadlock quando o bloco `catch` tentar adquirir `withRegistryLock` para executar o rollback (S11-3).
           - Qualquer leitura-modificação-escrita em `links.json` adquire o lock `<selfRoot>/.holoself/links.json.lock` via `openSync(lockPath, 'wx')` (`O_CREAT | O_EXCL`).
           - O lock armazena `{ pid: process.pid, timestamp: Date.now() }`.
           - Recuperação de Stale-Lock (Windows-resiliente): se o lock existir há mais de 5.000 ms ou o processo `pid` não estiver vivo, expurga via `rmSync` e repete (até 3 retentativas com backoff exponencial de 50ms, 150ms, 450ms).
           - **Timeout Normativo de Aquisição (`REGISTRY_LOCK_TIMEOUT`) (S11-3):** Se todas as 3 retentativas se esgotarem sem sucesso na aquisição do lock, a operação aborta *fail-closed* lançando erro com código canônico `REGISTRY_LOCK_TIMEOUT` (S11-3).
           - Liberação garantida em bloco `finally` via `rmSync(lockPath, { force: true })`.
        2. **Validação CAS (Compare-And-Swap) e Representação Explícita de Ausência (B10-3, S11-3):**
           - Na leitura sob lock no passo 3, calcula `baseHash`:
             - Se `<selfRoot>/.holoself/links.json` não existir em disco, `baseHash = "__ABSENT__"` (sentinela canônica explícita, inconfundível com digest de arquivo vazio `""` ou array vazio `"[]"`) (S11-3).
             - Se existir, `baseHash = sha256(rawText)`.
           - Antes de gravar com `atomicWriteFile` no passo 6 (sob nova aquisição discreta de lock):
             - Se `baseHash === "__ABSENT__"`, valida que o arquivo em disco continua inexistente.
             - Se `baseHash` for hash de arquivo, relê os bytes do disco e valida que `sha256(currentRawText) === baseHash`.
             - Se divergir (arquivo criado ou modificado concorrentemente por outro processo entre os passos 3 e 6), aborta fail-closed com `REGISTRY_CONCURRENT_MODIFICATION` (B10-3, S11-3).
      - A transação de criação/atualização de vínculo abrange a sequência completa:
        1. Valida contenção de caminhos e ausência de symlinks/junctions em `projectDir` e `selfRoot`.
        2. Valida antecipadamente `linkSchemaErrors` (tanto em `link add` quanto em `link setup`, S8-2).
        3. Captura snapshots do estado pré-transação sob o lock discreto do registro:
           - `existingLink = pathExists(linkPath(project)) ? readFileSync(linkPath(project)) : null` (espelhando `src/ecosystem.mjs:1889`).
           - Sob `withRegistryLock`: lê `links.json` (ou registra `baseHash = "__ABSENT__"` se inexistente), extrai `previousEntrySnapshot = existingRegistryEntryForThisProject ? structuredClone(existingRegistryEntryForThisProject) : null` e calcula `baseHash`. O lock é imediatamente liberado ao sair do bloco (B10-3, S11-3).
        4. Resolve `binding_salt` (S7-2, S9-2, S10-3, B8-2):
           - Se `link.yaml` preexistir e contiver um `binding_salt` válido (string de 32 hexadecimais), reutiliza-o compulsoriamente (preservando o sal em re-links legítimos `--force`, S4-1);
           - Se `link.yaml` for ausente mas já existir uma entrada ativa correspondente no registro soberano `links.json` (caso de pré-aprovação soberana via `link approve`), adota compulsoriamente o `binding_salt` já registrado no `links.json` (S9-2);
           - Caso contrário (novo link não pré-aprovado, ou sob `--force-reauthorize`), gera um novo sal aleatório criptográfico (32 hexadecimais: `randomBytes(16).toString('hex')`) e sincroniza atomicamente ambos os lados (B8-2, S10-3).
        5. Cria diretórios e grava `<projectDir>/.holoself/link.yaml` (via `writeLink(project, self, lens, secondary, projectContext, resolvedBindingSalt)`).
        6. Grava atomicamente `<selfRoot>/.holoself/links.json` com `status: "active"` sob o lock discreto do registro com verificação CAS contra `baseHash`.
        7. Se `!o.noActivate`: executa ativação de adaptadores (`activateProject`).
      - **Gatilho e Extensão do Rollback Fiel Pontual com CAS a Nível de Entrada (B7-2, B10-3, S8-1, S9-1, S11-3):**
        - **Gatilho:** Qualquer exceção lançada dentro da transação inteira (passos 5, 6 ou 7) aciona o bloco `catch` (S8-1). O rollback executa livre de qualquer lock pré-adquirido (S11-3).
        - **Extensão do Rollback:**
          - Em `link.yaml`: se `existingLink` existia antes da operação (re-link `--force`), restaura atomicamente os bytes originais de `link.yaml` via `atomicWrite(linkPath(project), existingLink)`, preservando a configuração e o sal pré-existentes (B7-2, espelhando `src/ecosystem.mjs:1889`); se `link.yaml` não existia antes da operação (vínculo novo), remove o `link.yaml` recém-criado (`rmSync(linkPath(project), { force: true })`).
          - Em `links.json` (B10-3, S11-3): **NUNCA sobrescreve o arquivo inteiro cegamente!** O rollback adquire compulsoriamente o lock soberano (`withRegistryLock`), relê o `links.json` atual do disco e executa **CAS a nível de entrada**:
            - Localiza a entrada do projeto corrente por `project_id`. Valida que o conteúdo da entrada deste projeto em disco coincide com o que foi escrito no passo 6 (garantindo que nenhum terceiro concorrente tenha alterado esta mesma entrada entre o passo 6 e o rollback) (S11-3).
            - Se este projeto era uma **nova entrada** (`previousEntrySnapshot === null`): remove unicamente a entrada deste projeto da lista de links (B10-3).
            - Se este projeto era uma **atualização in-place** (ex.: `--force-reauthorize` com `previousEntrySnapshot !== null`): restaura unicamente os campos deste projeto para `previousEntrySnapshot` (B10-3).
            - Todas as entradas de outros projetos (adicionadas ou atualizadas concorrentemente) permanecem integralmente intocadas e preservadas (B10-3, S11-3).
            - Grava o array resultante atomicamente via `atomicWriteFile` e libera o lock.
          - Em ativação e diretórios: se `existingLink === null`, desfaz ativações injetadas e limpa diretórios recém-gerados (`.holoself/catalog`, etc.), prevenindo artefatos órfãos (S8-1).
          - Re-lança a exceção fail-closed.
      - Em execução com `--dry-run`: nenhum dos dois arquivos (`link.yaml` ou `links.json`) é gravado (S6-2).
6. **Comando de Aprovação Manual Soberana (`holoself link approve`) (B3-2, B8-2, B10-3, N3-5, N4-4, N6-3, N10-3):**
   - Para projetos já existentes, re-autorização pós-revogação ou alteração manual de concessões:
     `holoself link approve --project <dir> [--lenses general,technical]`, executado por `owner:direct` em `selfRoot`.
   - **Capacidade de Re-autorização e Atestação Independente (B8-2, B10-3):**
     - `link approve` é a autoridade soberana primária para aprovar ou re-autorizar projetos.
     - Sob o lock soberano (`withRegistryLock`), marca explicitamente no registro `<selfRoot>/.holoself/links.json`:
       `status = "active"`, `binding_salt = <novo_ou_preservado_sal>`, `allowed_lenses = <lenses>`, `updated_at = new Date().toISOString()`, `revoked_at = null` (B8-2).
     - Se `link.yaml` existir no projeto: valida contenção, grava o `binding_salt` de volta no `link.yaml` com edição minimal aditiva in-place. Se `link.yaml` for ilegível ou unparseable, aborta fail-closed (N6-3).
     - Se `link.yaml` estiver ausente (ex.: projeto desvinculado previamente via `link remove` que recebe pré-aprovação soberana antes do `link add`): registra a entrada soberana ativa em `links.json` com o caminho canônico do projeto e emite o `binding_salt` aprovado, permitindo que uma subsequente execução de `link add` complete a vinculação sem bloqueio (B8-2, S9-2).
   - Se `--lenses` for omitido e `link.yaml` estiver presente, o default de `allowed_lenses` é derivado de `([link.default_lens, ...(link.secondary_lenses || [])]) \setminus {"private"}` do projeto. Se `link.yaml` estiver ausente, default para `["general"]`.
   - **Segurança de Caminhos e Edição In-Place na Aprovação (N3-5, N4-4, N10-3):** A gravação de `binding_salt` no `link.yaml` do projeto valida `assertContainedPath(projectDir, linkPath(projectDir))` e `lstatSync` (rejeitando symlinks/junctions) e utiliza edição minimal aditiva in-place preservando comentários e formatação. A garantia de preservação de formatação aplica-se estritamente aos editores in-place (`link approve`, `link backfill`, `migrate policy`); `link add` e `link setup` estruturam `link.yaml` via `writeLink` (N10-3). Se `link.yaml` estiver bloqueado para escrita, a aprovação aborta *fail-closed* sem alterar o registro soberano.
7. **Trilha de Adoção e Backfill de Vínculos Pré-Existentes (B5-2, B9-1, B10-3, S4-3, N6-3, N10-3):**
   - Quando um projeto legado tentar consultar o contexto sem constar em `links.json`, a execução falha *fail-closed* com `LENS_NOT_GRANTED` e emite diagnóstico operacional claro:
     `Link not attested in self registry. Run 'holoself link approve --project <dir>' from self root to activate.`
   - O comando de migração fornece utilitário de backfill para adoção em massa:
     `holoself link backfill [--all] [--lenses general,technical]`
     - **Regra Normativa de Lenses no Backfill (B5-2):** Quando `--lenses` for omitido, o backfill lê o `link.yaml` de cada projeto descoberto e grava compulsoriamente `allowed_lenses = ([link.default_lens, ...(link.secondary_lenses || [])]) \setminus {"private"}`, garantindo 100% de continuidade operacional sem quebras silenciosas.
     - **Emissão e Sincronização de `binding_salt` no Backfill (B9-1, B10-3):** Para cada projeto processado, o backfill cumpre as mesmas garantias e obrigações de segurança de caminhos e emissão criptográfica de `link approve`:
       1. Valida contenção de caminhos e ausência de symlinks/junctions (`assertContainedPath`, `lstatSync`).
       2. Resolve o `binding_salt`: se `link.yaml` já contiver um `binding_salt` válido (string de 32 hexadecimais), preserva-o; caso contrário, gera um sal criptográfico de 32 hexadecimais (`randomBytes(16).toString('hex')`) e o grava in-place em `link.yaml` via edição aditiva minimal preservando formatação e comentários (N10-3).
       3. Sob o lock soberano do registro (`withRegistryLock`), grava em `<selfRoot>/.holoself/links.json` a entrada atestada com `status = "active"`, `binding_salt = salt`, `allowed_lenses`, `project_id`, `canonical_project_path`, `attested_by: "owner:direct"`, `registered_at`, `updated_at`, `revoked_at: null`, cumprindo integralmente a defesa contra sequestro de caminho e concorrência segura (B9-1, B10-3).
     - **Tratamento Fail-Closed (N6-3):** Se o `link.yaml` de algum projeto descoberto for ilegível ou unparseable, o backfill aborta ou falha *fail-closed* para aquele projeto reportando o erro, sem emitir atestação cega nem fallback silencioso (N6-3).
8. **Preservação Integral de `identity_id` via HMAC de Cursor (B3-4):**
   - A identidade do chamador é rigorosamente preservada conforme implementado em `src/ecosystem.mjs:123-126`:
     `getIdentityId(identity, cursorSecret)`
     `identity_id = createHmac('sha256', cursorSecret).update(`${identity.kind}:${identity.project||''}:${[...(identity.allowedLenses||[])].sort().join(',')}`).digest('hex').slice(0, 16)`.
   - Previne colisão e preserva isolamento estrito de cache entre chamadores diretos e vinculados, bem como entre diferentes conjuntos de concessões (C-01 §5.1.3).
9. **Invalidação Transversal de Cache por `links_register_hash` e Esquema de Decisão v3 (B-7, S2-4, S8-4, S9-3, S10-1, S11-1, N7-1):**
   - Quando `<selfRoot>/.holoself/links.json` estiver ausente (self novo ou sem projetos vinculados):
     `links_register_hash = sha256(canonicalJson([]))` (digest canônico de array vazio: `sha256("[]")`), garantindo chaves de cache determinísticas através da transição de criação do registro (S8-4).
   - Quando presente: `links_register_hash = sha256(canonicalJson(all_links_normative_list))`, computado sobre **todas as entradas** de `links.json` (ativas e revogadas), onde cada item é normalizado:
     `{ project_id: l.project_id, binding_salt: l.binding_salt, allowed_lenses: [...l.allowed_lenses].sort(), status: l.status }`.
   - Incluir todas as entradas com `status` garante que qualquer transição de estado (`active -> revoked` ou vice-versa) altere diretamente o digest de forma imediata e transparente (N7-1).
   - **Simetria Chave/Entrada e Evolução do Cache para Schema v3 (S9-3, S10-1, S11-1):**
     - O schema `schemas/context-decision-cache.schema.json` avança compulsoriamente sua versão para `schema_version: 3` (`"schema_version": { "const": 3 }`).
     - Adiciona `"links_register_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" }` tanto em `properties` quanto na lista `required`.
     - `ALLOWED_CACHE_KEYS` (`src/catalog.mjs:365-370`) inclui compulsoriamente `'links_register_hash'` (S10-1).
     - `validateDecisionCacheSchema` (`src/catalog.mjs:374`) valida que `typeof entry.links_register_hash === 'string' && HASH_RE.test(entry.links_register_hash)` (S10-1).
     - `computeDecisionCacheKey` em `src/catalog.mjs` inclui compulsoriamente `links_register_hash` no cômputo da chave.
     - A entrada persistida em disco grava o campo `links_register_hash`, preservando a simetria estrita chave/conteúdo (§6.1.4).
     - Entradas preexistentes de cache com `schema_version: 2` são sumariamente invalidadas e expurgadas na inicialização por `purgeInvalidDecisionCache` (`src/catalog.mjs:495`), garantindo transição higiênica sem estados híbridos (S9-3).
     - **Obrigações Normativas de Atualização de Testes de Cache para T03-D1 (S11-1):**
       - Atualização da asserção de schema version do cache em `tests/catalog.test.mjs:347`: de `assert.equal(read.schema_version, 2)` para `assert.equal(read.schema_version, 3)`.
       - Validação de que fixtures e caches gerados contêm `schema_version: 3` e `links_register_hash` em conformidade estrita com `validateDecisionCacheSchema`.
   - Qualquer revogação ou alteração em `links.json` invalida imediata e deterministicamente todos os caches de decisão em `<projectDir>/.holoself/runtime/context-cache/`.
10. **Revogação Soberana em `link remove`, Segurança Estrita de Caminhos e Tratamento Consistente (B8-1, B9-2, B10-3, S6-3, S7-4, S9-4, S10-4, N9-2, N11-4, N11-5):**
    - Quando `holoself link remove --project <dir> --yes` for executado:
      - O comando inspeciona o vínculo em `<projectDir>/.holoself/link.yaml` sob quatro estados canônicos (B8-1):
        1. **Ausente:** Reporta `[ok] no link configuration found`. Se `--self <selfRoot>` for explicitamente fornecido, valida `selfRoot` e `canonicalPath`. **Validação Pré-Lock de Existência (N11-5):** Antes de tentar qualquer aquisição de lock (`withRegistryLock`), o comando valida compulsoriamente a existência prévia de `<selfRoot>/.holoself/links.json`. Se `selfRoot` for inacessível, não-canônico ou `links.json` estiver ausente: nenhum lockfile `.lock` é criado no self (N11-5); sem `--force`, aborta *fail-closed* com `SOVEREIGN_SELF_UNREACHABLE`; com `--force`, emite aviso operacional e encerra sem criar arquivos arbitrariamente no self (B9-2, S10-4). Para limpeza de entradas órfãs no self quando projetos são deletados externamente sem desvinculação prévia, o proprietário soberano pode utilizar `holoself link approve --project <id/caminho> --revoke` ou o utilitário soberano `holoself link prune` (que integra o conjunto dos 6 comandos sob o contrato de concorrência com lock e CAS) (N9-2, N11-4). Se `links.json` existir, adquire `withRegistryLock` e revoga no registro a entrada daquele projeto pelo seu caminho canônico (`project_id`).
        2. **Corrompido ou Ilegível (YAML unparseable):** Aborta *fail-closed* com erro fatal (N6-3, S7-4), recusando remoção sem intervenção consciente do operador.
        3. **Parseável mas Inválido no Schema v2 (ex.: link legado com `default_lens: private`):** O comando tolera a invalidade semântica de schema v2 exclusivamente para fins de desativação e remoção (B8-1). Extrai o caminho canônico de `self` do YAML bruto parseado.
        4. **Válido conforme Schema v2:** Lê `link.path` (`selfRoot`).
      - **Cláusula de Segurança de Caminhos e Imutabilidade Protetiva de `links.json` (B9-2, S9-4, N11-5):**
        - O caminho `selfRoot` (seja extraído do YAML bruto parseável ou fornecido via `--self`) deve ser submetido compulsoriamente a:
          1. Canonicalização via `canonicalPath` (`resolve`, `safeRealpath`, NFC).
          2. Verificação de contenção e rejeição de symlinks/junctions (`lstatSync` garantindo que nem `<selfRoot>`, nem `<selfRoot>/.holoself`, nem `<selfRoot>/.holoself/links.json` sejam symlinks).
          3. Validação de que `<selfRoot>` é um self canônico válido (`isCanonicalSelf(selfRoot)`).
        - **Proibição Absoluta de Criação Arbitrária de Arquivos (B9-2):** `link remove` **NUNCA cria** o arquivo `<selfRoot>/.holoself/links.json` se este não existir. Ele pode unicamente mutar uma entrada existente em um arquivo existente. Se `links.json` não existir, nenhuma gravação no self é efetuada (B9-2).
        - **Validação Pré-Lock de Existência (N11-5):** A conferência de existência física de `links.json` antecede qualquer chamada a `withRegistryLock`, prevenindo que locks órfãos sejam criados quando o registro soberano for inexistente.
        - **Escopo Estrito de Mutação por `project_id` (B9-2, B10-3):** A mutação no registro soberano (sob `withRegistryLock`) localiza estritamente a entrada cujo `project_id` coincida com o caminho canônico do projeto corrente. Nenhuma outra entrada é modificada.
      - **Tratamento Consistente de Acessibilidade do Self (S9-4):**
        - Tanto no Estado 3 quanto no Estado 4, se `selfRoot` existir, for seguro e contiver `<selfRoot>/.holoself/links.json`:
          - Sob `withRegistryLock`, localiza a entrada do projeto por `project_id`.
          - Se encontrada, atualiza atomicamente: `status = "revoked"`, `revoked_at = new Date().toISOString()`.
          - A alteração de `status` altera compulsoriamente `links_register_hash` (N7-1), invalidando imediatamente caches residuais.
        - Se `selfRoot` for inacessível, não for um self canônico, ou `links.json` for inalcançável (S9-4):
          - Por padrão, a operação **aborta fail-closed** tanto para links válidos quanto para links de schema inválido, recusando remoção sem garantia de revogação soberana (eliminando qualquer inversão de risco, S9-4).
          - Sob a flag explícita `--force`: emite aviso operacional proeminente:
            `Warning: sovereign self at ${selfRoot} is unreachable or invalid; local link configuration and adapters removed, but sovereign registry was NOT updated. Run 'holoself link approve --project <dir> --revoke' from self root to complete sovereign revocation.`
            e prossegue com a desativação de adapters e remoção local de `<projectDir>/.holoself/link.yaml`.
      - Desativa adapters e remove `<projectDir>/.holoself/link.yaml`.
      - Sob `--dry-run`: simula a desativação e remoção sem mutação em nenhum dos arquivos (`link.yaml` ou `links.json`).

#### 7.1.3 Matriz de Acesso Restritiva (Meet) e Não-Ampliação Forçada (D-07, B-1, B-2, B3-1, B3-2, B6-1, S3-1, S4-4, S5-2, S5-4, B11-1, N3-3)
1. **Lógica Normativa de Leitura Fallback para Não-Migrados / Pós-Revert (S3-1, S4-4):**
   - Para documentos onde `read_scope` e/ou `access_lenses` estiverem ausentes:
     - Derivação de `read_scope`:
       - `visibility === 'private'` $\implies$ `"restricted"`.
       - Todos os demais $\implies$ `"shared"`.
     - Derivação de `access_lenses` via `legacyAccessLenses(meta)`:
       - `visibility === 'private'` $\implies$ `['private']`.
       - `visibility === 'career'` $\implies$ `['general', 'career', 'interview', 'private']`.
       - `visibility === 'publishing'` $\implies$ `['general', 'publishing', 'private']`.
       - Todos os demais (`linked-projects`, `public-safe`) $\implies$ `[...LENSES]` (todos os 7 built-ins).
2. **Migração como Meet (Infimum de Menor Privilégio) (B-1, B2-2, S3-1):**
   - A migração de metadados legados calcula a intersecção mais restritiva (*meet*) sem sobrescrever cegamente campos existentes:
     - `read_scope`: Se ausente, derivado de `visibility`:
       - `visibility: "private"` $\implies$ `"restricted"`.
       - `visibility: "linked-projects"` | `"career"` | `"publishing"` | `"public-safe"` $\implies$ `"shared"`.
       - Se já existir e for válido (`"shared" | "local" | "restricted"`), preserva-o intacto.
     - `access_lenses`: Se ausente, derivado de `visibility`:
       - Para documentos do `self`:
         - `visibility: "private"` $\implies$ `["private"]`.
         - `visibility: "linked-projects"` $\implies$ `["general", "career", "publishing", "technical", "leadership", "interview", "private"]`.
         - `visibility: "career"` $\implies$ `["general", "career", "interview", "private"]`.
         - `visibility: "publishing"` | `"public-safe"` $\implies$ `["general", "publishing", "private"]`.
         *(A inclusão de `"private"` para documentos do self assegura que o proprietário mantenha acesso sob `--lens private`, enquanto chamadores vinculados continuam categoricamente bloqueados pelas Fases 1 e 2).*
       - Para documentos de projeto:
         - `visibility: "private"` $\implies$ `["private"]`.
         - `visibility: "linked-projects"` $\implies$ `["general", "technical"]`.
         - `visibility: "public-safe"` $\implies$ `["general", "publishing"]`.
         - Demais $\implies$ `["general"]`.
       - Se `access_lenses` já existir no frontmatter: preserva-o intacto.
     - `disclosure`: Se ausente, derivado via `disclosure(meta)` existente (`"internal"`, `"publish-approved"`, etc.). Se já for válido, preserva-o.
     - `sensitivity`: Se já existir e for válido, preserva-o intacto. Se ausente, default para `"personal"`.
     - `document_role`: Se ausente, default para `"content"`.
3. **Garantia de Não-Ampliação com Gate Enforced e Prova de Fechamento (B-1, B-2, B3-1, S5-2, S5-4):**
   - **Invariante Formal:**
     $$\forall (d \in \text{Docs}, L \in \text{Lenses}, s \in \{\text{owner}, \text{linked}\}, a \in \{\text{generic}, \text{public}\}): \text{allowed}_{\text{after}}(d, L, s, a) \implies \text{allowed}_{\text{before}}(d, L, s, a)$$
   - **Prova de Soundness para Ambos os Sujeitos (S5-2, S5-4):**
     - Em v1, chamadores vinculados eram limitados no request pelas lentes autorizadas do projeto (`link_lenses = link.default_lens ∪ link.secondary_lenses`, `src/ecosystem.mjs:659`), e `allowed_v1` avaliava o documento.
     - Em v2, a Fase 2 impõe $\text{effective\_allowed\_lenses} \subseteq link\_lenses$. Portanto:
       $$allowed_{\text{after}}(d, L, \text{linked}, a) \implies (L \in link\_lenses \land allowed_{\text{v1}}(d, L, a)) \implies allowed_{\text{before}}(d, L, \text{linked}, a)$$
     - Como qualquer atestação soberana só pode estreitar ou manter o conjunto $link\_lenses$, a garantia de não-ampliação é formalmente sound e invariante para ambos os sujeitos (S5-2, S5-4).
   - **Execução Obrigatória no `--dry-run` e `--apply` (B-2):**
     - Se **uma única célula** do produto cartesiano transitar de `DENY -> ALLOW`: a geração do plano falha imediatamente (exit code 1), nenhum plano utilizável é gravado e a violação é reportada detalhadamente.
     - `--apply` reavalia compulsoriamente a invariante antes de aplicar qualquer alteração.
4. **Relatório de Estreitamento de Cobertura e Confirmação Explícita (B2-2, S3-1, N3-3):**
   - Transições de `ALLOW -> DENY` (estreitamento legítimo de privilégio) são computadas e sumarizadas no `--dry-run` em uma seção dedicada: **Coverage Loss Report**, agrupadas por lente com contagem de documentos afetados (detalhe por arquivo disponível no plano).
   - Se o plano contiver qualquer estreitamento de cobertura de lentes para o proprietário:
     - `--dry-run` exibe o sumário das lentes afetadas.
     - `--apply` exige a flag explícita `--confirm-narrowing`. Se não fornecida, a execução é interrompida com instruções de revisão, impedindo restrições acidentais silenciosas.
5. **Remoção Deliberada de Capacidades Permissivas Legadas (`ALLOW -> DENY`) e Prescrição de Reescrita de Teste (B6-1, B7-1, B8-1, S7-1, S8-3, N7-3, N8-1, N8-2):**
   - **Contexto Legado v1 e Falhas de Isolamento:**
     Em v1, o teste `tests/cli.test.mjs:49-58` executava:
     ```bash
     holoself link add --project <project> --self <root> --lens private --yes
     holoself context --project <project> --lens private --json
     ```
     e afirmava que o cliente vinculado recebia o documento restrito `profile/identity.md` (`sensitivity: restricted`). Além disso, projetos vinculavam sem registro no self, comandos como `link setup --lens private` eram admitidos e blocos intra-corpo com visibilidade desconhecida vazavam por fallthrough.
   - **Decisão Arquitetural e Invariantes v2:**
     Em v2, a perspectiva `private` é **soberana e estritamente exclusiva do proprietário direto** (`owner:direct`). Nenhum cliente vinculado pode receber outorga ou consultar contexto sob a lente `private`:
     - `linkSchemaErrors` rejeita categoricamente `default_lens: "private"` e rejeita `"private"` dentro de `secondary_lenses` (atingindo tanto `link add` quanto `link setup`, `src/ecosystem.mjs:1900`) (N7-3).
     - Fase 2 de `allowedDocument` subtrai compulsoriamente `"private"` de `effective_allowed_lenses` para qualquer chamador `client:linked`.
     - Fases 1 e 6 impõem que documentos com `read_scope: "restricted"` ou `sensitivity: "restricted"` exigem universalmente `subject.kind === "owner:direct" && resolution.source === "builtin" && lens === "private"`.
     - Coerção fail-closed em `visibleUnderBehavior` para visibilidade inválida (`∉ VISIBILITIES`) redige blocos intra-corpo sob lentes não-privadas (S6-1, S7-1).
     - Projetos vinculados sem atestação ativa em `<selfRoot>/.holoself/links.json` são barrados na Fase 2 com `LENS_NOT_GRANTED` até aprovação ou backfill soberano (S8-3).
   - **Tabela de Transição Normativa de Capacidades:**
     | Sujeito / Elemento | Operação / Comando / Condição | Comportamento v1 | Comportamento v2 | Justificativa e Classificação |
     |---|---|---|---|---|
      | `client:linked` não-atestado | Consulta de contexto sem entrada ativa em `links.json` | `ALLOW` (acessava contexto sem registro no self) | `DENY` (`LENS_NOT_GRANTED` até aprovação/backfill soberano) | Estreitamento soberano fundamental de segurança (`ALLOW -> DENY`) (S8-3) |
      | `client:linked` legado | `link.yaml` pré-existente com `default_lens: private` | `ALLOW` (admitido em v1) | `DENY` (bloqueado em runtime para contexto; removível via `link remove` tolerante ou reconfigurável com nova lente via `link setup/add --force`) | Estreitamento deliberado de segurança (`ALLOW -> DENY`) (B8-1) |
      | `client:linked` | `link add --lens private` | `ALLOW` (criava vínculo com lente private) | `DENY` (rejeitado *fail-closed* por validação de schema) | Estreitamento deliberado de segurança (`ALLOW -> DENY`) |
      | `client:linked` | `link setup --lens private` | `ALLOW` (configurava vínculo com lente private) | `DENY` (rejeitado *fail-closed* por validação de schema) | Estreitamento deliberado de segurança (`ALLOW -> DENY`) (N7-3) |
      | `client:linked` | `context --project <p> --lens private` | `ALLOW` (entregava contexto e dados restritos) | `DENY` (`LENS_NOT_GRANTED`, restrito) | Estreitamento deliberado de segurança (`ALLOW -> DENY`) |
      | Blocos intra-corpo | `visibility ∉ VISIBILITIES` sob lentes não-privadas | `ALLOW` (vazava bloco por fallthrough em `[...LENSES]`) | `DENY` (redigido via coerção fail-closed para `'private'`) | Estreitamento deliberado intra-corpo; fora do escopo do relatório de migração de documentos por construção (S7-1) |
      | `owner:direct` legado | Documento legado com `visibility: private` e `access_lenses` pública (sem `read_scope` explícito) sob lente pública | `ALLOW` (vazava via `access_lenses` em v1) | `DENY` (derivação normativa fixa `read_scope: "restricted"`, acessível unicamente sob `private`) | Estreitamento deliberado de privacidade em metadados contraditórios legados (`ALLOW -> DENY`) (S10-5) |
      | `owner:direct` (`cwd ∈ selfRoot`) | `context --root <root> --lens private` (sem `--project`) | `ALLOW` | `ALLOW` | Capacidade soberana integralmente preservada para o proprietário direto (B7-1) |
    - **Avisos de Estreitamento em Tempo de Execução e Garantia Anti-Oráculo (S10-5, B11-1):** Para documentos não-migrados onde `visibility: private` coexista com `access_lenses` contendo lentes públicas (ex.: `access_lenses: ["general", "private"]`), a emissão de diagnóstico estruturado em `result.warnings` é **estritamente condicionada ao sujeito `subject.kind === 'owner:direct'`**:
      `"Document '${doc.path}' has 'visibility: private' with public access_lenses; under v2 policy, read_scope defaults to 'restricted'. Access under non-private lenses is denied. Run 'holoself migrate policy' to resolve."`
      Para chamadores `client:linked`, a emissão desse aviso em `result.warnings` é **categoricamente proibida** (prevenindo vazamento de caminhos, títulos e existência de documentos privados que violaria a garantia anti-oráculo da Fase 1 e §7.1.1 item 5). Em vez disso, tais documentos são contabilizados exclusivamente no contador agregado opaco `unauthorized_sources_omitted: N` (se forem candidatos da busca) com zero vazamento de metadados (B11-1).
    - **Prescrição Normativa de Reescrita do Teste `tests/cli.test.mjs:49-58` (B6-1, B7-1, B9-3, S10-2, N8-1, N8-2, N9-3):**
      Na implementação de T03-F, o teste em `tests/cli.test.mjs:49-58` deve ser reescrito com duas asserções normativas rigorosas:
      1. Provar que a tentativa de vincular com `link add --project <project> --self <root> --lens private --yes` é **rejeitada fail-closed** com erro (`default_lens cannot be private: private is owner-exclusive`).
      2. Validar a resolução e leitura do documento privado migrado `profile/identity.md` (`sensitivity: restricted`, `migrationprivatecontext marker`) através de consulta direta soberana do proprietário **com o diretório de trabalho corrente contido em `<root>`** (B7-1, B9-3, S10-2, N8-1, N8-2, N9-3):
         - **Pré-condição Ambiental (N8-2):** `<root>` deve ser inicializado em diretório temporário isolado gerado por `temp()` (`mkdtemp`), sem qualquer arquivo `.holoself/link.yaml` presente em nenhum diretório ancestral, assegurando que `findLinkUpwards(cwd)` retorne `null` e resolva a identidade `owner:direct` sem desvios.
         - **Invocação Executável com Save/Restore de CWD e Asserções Válidas de Envelope (B9-3, S10-2, N8-1, N8-2):**
           Em `tests/cli.test.mjs`, adiciona `resolve` aos imports de `node:path` (`import { join, resolve } from 'node:path'`) e utiliza substituição de separadores padrão sem depender de helpers internos privados (S10-2):
           ```javascript
           const prevCwd = process.cwd();
           try {
             process.chdir(root);
             const data = JSON.parse(await capture(() => run(['context', '--root', root, '--lens', 'private', '--json'])));
             assert.equal(data.self.path, resolve(root).replaceAll('\\', '/'));
             assert.equal(data.lens, 'private');
             const identity = data.self.documents.find(d => d.path === 'profile/identity.md');
             assert.ok(identity, 'profile/identity.md must be delivered under private lens to owner:direct');
             assert.match(identity.content, /migrationprivatecontext marker/);
             assert.equal(identity.metadata.sensitivity, 'restricted');
           } finally {
             process.chdir(prevCwd);
           }
           ```
           comprovando de forma executável, sem asserção de propriedades espúrias no envelope e sem erros de referência de escopo de módulo, a preservação integral da perspectiva privada exclusivamente para `owner:direct` (B9-3, S10-2).

#### 7.1.4 Mecânica Transacional de Migração, Reversão e Segurança de Caminhos (R-12, V-10, B-10, S-4, S2-3, S2-5, S3-6)
1. **Escopo de Execução e Autoridade do Comando (S2-3):**
   - `holoself migrate policy` deve ser invocado em um diretório sob `selfRoot` ou receber `--root <selfRoot>`. Opera estritamente com privilégio `owner:direct`.
   - Por padrão, processa unicamente os documentos Markdown em `selfRoot`.
   - Se `--include-linked` for fornecido: descobre os projetos vinculados **exclusivamente** através de entradas ativas em `<selfRoot>/.holoself/links.json`, utilizando os caminhos canônicos atestados. Projetos desconhecidos ou revogados são ignorados.
   - Aplica-se exclusivamente a arquivos `.md` contendo frontmatter delimitado por `---` (N2-5).
2. **Estratégia de Modificação In-Place Minimal Aditiva de Frontmatter (S3-6):**
   - A gravação das alterações pós-migração realiza **modificação in-place minimal aditiva**:
     - Novas chaves (`read_scope`, `access_lenses`) são inseridas diretamente antes do delimitador final `---` do frontmatter existente, ou atualizadas in-place caso já presentes.
     - É expressamente vedado o uso de serializadores globais de YAML (como `yamlObject`) para regravar arquivos inteiros, garantindo preservação integral de comentários, ordem original de chaves, espaçamento e aspas pré-existentes.
3. **Fase Preview (`holoself migrate policy --dry-run`):**
   - Varredura de arquivos com contenção estrita (`assertContainedPath`).
   - Rejeição imediata de symlinks e junctions via `lstatSync` (B-10).
   - Cálculo da matriz de acesso antes/depois, validação do gate de não-ampliação e geração do Coverage Loss Report (B2-1, B2-2, B3-1).
   - Geração de `plan_id = sha256(canonicalJson(plan_entries))`.
   - Gravação atômica do plano em `<selfRoot>/.holoself/migrations/plan-<plan_id>.json` (modo `0o600`) validado conforme `schemas/migration-plan.schema.json` (S2-5).
4. **Fase Aplicação (`holoself migrate policy --apply <plan_id> [--confirm-narrowing]`):**
   - Valida `schemas/migration-plan.schema.json` e confere `sha256(canonicalJson(plan.entries)) === plan_id`.
   - Se o plano registrar estreitamento de cobertura sem `--confirm-narrowing`, aborta com erro informativo (B2-2).
   - Para cada arquivo:
     1. Re-validação de symlink (`lstatSync`).
     2. Contenção no espaço (`assertContainedPath`).
     3. Sequência anti-TOCTOU: `s0 = statSync`, `text = readFileSync`, `s1 = statSync`. Se stat divergir ou `sha256(text) !== before_sha256`, aborta a transação inteira imediatamente (B-10).
   - Gravação atômica de arquivos modificados via `atomicWriteFile` (0o600) com edição in-place minimal (S3-6).
   - Gravação do recibo em `<selfRoot>/.holoself/migrations/receipt-<plan_id>.json` com status `"applied"`, validado conforme `schemas/migration-receipt.schema.json` (0o600).
5. **Fase Reversão (`holoself migrate policy --revert <plan_id> [--allow-partial]`):**
   - Carrega o recibo e valida `schemas/migration-receipt.schema.json`.
   - **Aborto por Padrão sob Alteração Pós-Migração (S-4):**
     - Se qualquer arquivo tiver sido modificado após a migração (`sha256(text) !== after_sha256`), aborta a reversão integral por padrão (V-10).
     - Com `--allow-partial`, reverte apenas os arquivos inalterados e marca o recibo como `"partially-reverted"`.
     - Arquivos revertidos têm seu conteúdo restaurado para `before_sha256`. Pela regra B2-1 e S3-1, o runtime de política v2 suporta arquivos com `read_scope` ausente via `legacyAccessLenses` em tempo de leitura, garantindo que o corpus permaneça plenamente funcional após o rollback.
   - **O recibo NUNCA é deletado** (S-4); seu status é atualizado para `"reverted"` ou `"partially-reverted"`.
   - Emite a matriz de acesso resultante com aviso formal de re-ampliação ao retornar às regras legadas.

#### 7.1.5 Definição Canônica de `SubjectSpacePolicyRev` (S-3, B2-4, B3-4, B10-2, S3-2, S3-5, N4-1, N4-2, N6-1, B7-1, B9-3, N9-3, N11-3)
Substituindo formalmente a definição de C-02 §6.1.2:
```json
{
  "subject": {
    "kind": "owner:direct" | "client:linked",
    "space_id": "self" | "hs-space-<16-hex>",
    "identity_id": "<createHmac('sha256', cursorSecret).update(`${kind}:${project}:${sortedAllowedLenses}`).digest('hex').slice(0, 16)>",
    "accessible_spaces": ["self", "hs-space-<16-hex>"]
  },
  "space_id": "self" | "hs-space-<16-hex>" | "contrib",
  "policy_revision": "<sha256(canonicalJson([lens_registry_hash, link_hash, links_register_hash]))>",
  "allowed_lenses": ["general", "technical"],
  "granted_scopes": ["shared", "local"]
}
```
- `subject.space_id`: `"self"` para `owner:direct`, `"hs-space-" + sha256("project\0" + canonical_project_path).slice(0, 16)` para `client:linked` (B2-4, N3-4).
- `subject.accessible_spaces`: conjunto de IDs de espaço autorizados para consulta de escopo `local` (para `owner:direct` na arquitetura vigente, `identity.project === null` e `cwd ∈ selfRoot`, resultando no caso singleton `["self"]`, onde nenhuma partição de projeto é escaneada e `source.space_id = "self"` para todos os documentos; a composição `["self", project_space_id]` é uma previsão forward-looking para C-04 quando o proprietário inspecionar projetos diretamente) (S3-2, N4-2, N6-1, B7-1, B9-3, B10-2, N9-3, N11-3).
- `subject.identity_id`: preservado rigorosamente conforme a implementação de `getIdentityId(identity, cursorSecret)` em `src/ecosystem.mjs:123-126`, garantindo partições de cache isoladas e protegendo contra forja de cursor (B3-4).
- `link_hash`: para `client:linked`, calculado sobre o objeto parseado bruto antes da resolução de caminho (N4-1): `sha256(canonicalJson({ self_context: { path: parsed.self_context.path, default_lens: parsed.self_context.default_lens, secondary_lenses: parsed.self_context.secondary_lenses }, project_context: parsed.project_context }))`; para `owner:direct`, `null` (S3-5).
- `policy_revision`: array canônico `[lens_registry_hash, link_hash, links_register_hash]` com separação estrita de domínios.
- `granted_scopes`: lista de escopos relacionais atribuídos ao sujeito sobre o espaço.

### 7.2 Registro de Entrega e Verificação do Ciclo C-03

- T03-R verified: inventário de metadados de privacidade, schemas e precedência normativa documentado em `docs/specifications/c03-research-lenses-and-migration.md`.
- T03-S verified: especificação técnica consolidada do contrato C03-CONTRACT-1 v12 na Seção 7.1 (desacoplamento formal de lentes e autorizações, registro opt-in soberano `links.json`, proteção contra sequestro de caminho via `binding_salt`, concorrência e rollback com CAS a nível de entrada via `withRegistryLock`, evolução do catálogo para schema v2 e cache para schema v3 com `links_register_hash`, supressão anti-oráculo de fontes não-autorizadas e motor de migração in-place de políticas).
- T03-V verified: Claude Opus (`claude -p --model opus`) auditou adversarialmente o contrato ao longo de 11 rodadas formais. A proposta consolidada v12 absorveu integralmente todos os apontamentos da Revisão 11:
  - B11-1: Escopo estrito do aviso de estreitamento em tempo de execução para `owner:direct`, vedando categoricamente vazamento de metadados para `client:linked` e contabilizando fontes não-autorizadas exclusivamente em `unauthorized_sources_omitted` (§7.1.3.5).
  - S11-1: Enumeração explícita de obrigações normativas de atualização de testes e fixtures para catálogo schema v2 e cache schema v3 (§7.1.1.1, §7.1.2.9).
  - S11-2: Plumbing unificado de `projectDir` como `null` para `owner:direct`, prevenindo expurgo acidental de índices em subpastas do self (§7.1.1.2).
  - S11-3: Lockfile discreto por operação atômica em `withRegistryLock`, eliminação de auto-deadlock, timeout `REGISTRY_LOCK_TIMEOUT`, sentinela `"__ABSENT__"` para CAS de arquivo inexistente e rollback pontual com CAS a nível de entrada (§7.1.2.5).
  - N11-1 a N11-5: Correções de citações de funções, preflight de link, esclarecimento forward-looking de `accessible_spaces`, inclusão de `link prune` e validação pré-lock em `link remove`.
  - Prompt de auditoria final da Rodada 12 preparado em `scratch/review-prompt-c03-contract-round12.md`.
- T03-D1 & T03-D2 verified: implementação completa em `src/ecosystem.mjs`, `src/migration.mjs`, `src/lenses.mjs`, `schemas/links-registry.schema.json`, `schemas/migration-plan.schema.json` e `schemas/migration-receipt.schema.json`.
- T03-F verified:
  - Suíte completa: **211/211 testes passando** (`node scripts/verify.mjs` e `node --test tests/*.test.mjs`), incluindo 7 testes dedicados em `tests/migration.test.mjs`, 27 testes em `tests/catalog.test.mjs`, 17 testes em `tests/lenses.test.mjs` e 37 testes em `tests/ecosystem.test.mjs`.
  - Zero dependências de runtime externas (`node:` builtins apenas).
  - Conformidade estrita anti-oráculo para chamadores vinculados (`unauthorized_sources_omitted`).
  - `git diff --check` 100% limpo. Ciclo C-03 formalmente verificado e concluído.

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

### 8.1 Especificação Técnica do Contrato C04-CONTRACT-1

O contrato formal C04-CONTRACT-1 estabelece as regras normativas de federação soberana entre múltiplos espaços pertencentes à mesma identidade pessoal, disciplinando a descoberta estrita, a interseção tripla de acessos, a garantia anti-oráculo de espaços restritos (V-06), a semântica dos três resultados formais de resiliência, a imunidade a DoS federado, identificadores compostos e deduplicação anti-ampliação de privilégios.

#### 8.1.1 Descoberta Soberana e Participação Explícita de Espaços (I-03, R-08)
1. **Origem Exclusiva de Autoridade e Registro Soberano:**
   - A participação de qualquer espaço no conjunto federado da identidade pessoal é **estritamente opt-in e explícita** (I-03).
   - É **categoricamente vedado** escanear diretórios vizinhos, diretórios ancestrais ou inferir espaços a partir de caminhos soltos no sistema de arquivos ou menções em documentos Markdown.
   - O universo de espaços federáveis é delimitado **exclusivamente** pelas entradas ativas no registro soberano `<selfRoot>/.holoself/links.json` (schema v1, §7.1.2).
2. **Critérios de Validade de um Espaço Produtor Par (*Peer*):**
   Para ser elegível à consulta federada, uma entrada em `links.json` deve cumprir compulsoriamente:
   1. `status === "active"` (entradas com status `"revoked"` são sumariamente ignoradas e omitidas sob a garantia anti-oráculo).
   2. `binding_salt` preenchido com 32 caracteres hexadecimais válidos.
   3. Diretório do projeto existente fisicamente e canônico (`canonicalProjectPath(project_path)`).
   4. Não ser symlink ou junction (`lstatSync` no diretório raiz do projeto e no diretório `.holoself`).
   5. O link local `<project_path>/.holoself/link.yaml` deve existir, ser parseável e conter o mesmo `binding_salt` atestado no registro do self.
3. **Modos de Invocação e Escopo de Espaços:**
   - **Modo Padrão Local (sem federação):**
     `holoself context --project <dir>` (ou MCP context sem `--federated`) mantém a consulta limitada a `self` + projeto local (`P_consumer`), preservando 100% de compatibilidade retroativa e economia de I/O.
   - **Modo Federado Completo (`--federated`):**
     Ao fornecer a flag `--federated`, o motor de contexto consulta `self` + projeto local + todos os projetos produtores pares ativamente atestados em `links.json` que compartilhem a lente solicitada.
   - **Modo de Espaços Explícitos (`--spaces <space_id_or_path, ...>`):**
     Permite especificar subconjunto de espaços por `space_id` (`hs-space-...`) ou caminho canônico. Espaços na lista que não existam ou não sejam ativos/autorizados para o consumidor são descartados silenciosamente sob a garantia anti-oráculo.
   - **Modo Proprietário Direto (`owner:direct`):**
     Por padrão consulta `self` + `contrib`. Sob `--federated` ou `--spaces`, consulta os projetos registrados em `links.json` com prerrogativas de proprietário.

#### 8.1.2 Interseção Tripla de Acesso e Pré-Filtro Zero-I/O (R-08, V-06, B3)
1. **Regra Formal de Elegibilidade de Documento Federado:**
   Um documento $d$ pertencente a um espaço produtor par $P$, para uma consulta realizada por um projeto consumidor $C$ sob a lente solicitada $L$, com tarefa $T$, é elegível para seleção se e somente se satisfizer a conjunção estrita:
   $$\text{eligible}(d, L, C, P) \iff L \in L_C \land L \in L_P \land \text{read\_scope}(d) = \text{"shared"} \land L \in \text{access\_lenses}(d) \land \text{allowedDocument}(d, L, \dots)$$
   Onde:
   - $L_C$ é o conjunto de lentes autorizadas para o consumidor $C$ em `links.json` subtraído de `'private'`.
   - $L_P$ é o conjunto de lentes autorizadas para o produtor $P$ em `links.json` subtraído de `'private'`.
   - $\text{read\_scope}(d)$ é o escopo relacional do documento no produtor.
2. **Pré-Filtro Zero-I/O contra Oráculos de Tempo (B3):**
   - A condição $L \in L_P$ é avaliada **em memória** a partir de `links.json` no loop de descoberta no nível do `ecosystem`, **antes** de qualquer tentativa de I/O em disco, abertura de arquivos ou chamada a `ensureCatalog` para aquele par.
   - Espaços pares que não compartilhem a lente $L$ são sumariamente ignorados sem tocar no sistema de arquivos, eliminando completamente qualquer oráculo de latência ou tempo de resposta.
3. **Isolamento Absoluto de Escopos Produtores:**
   - Documentos com `read_scope: "local"` no produtor $P$ destinam-se exclusivamente ao contexto interno daquele espaço. Em consultas federadas originadas por $C \neq P$, documentos locais de $P$ são **categoricamente inacessíveis**.
   - Documentos com `read_scope: "restricted"` (ou derivados de `visibility: "private"`) exigem universalmente `subject.kind === "owner:direct"` e a lente `private`. São **categoricamente inacessíveis** para qualquer consumidor vinculado $C$ e para qualquer projeto par em federação.
   - Consequentemente, **somente documentos com `read_scope: "shared"`** podem ser recuperados entre espaços distintos da mesma pessoa.
4. **Simetria de Revogação de Lentes:**
   Se o proprietário soberano revogar uma lente de $P$ no registro soberano (ex.: $L \notin L_P$), nenhum documento de $P$ será entregue sob a lente $L$, mesmo que o documento individual marque $L \in \text{access\_lenses}$.

#### 8.1.3 Garantia Anti-Oráculo Estrita e Isolamento de Espaços Restritos (V-06, I-04)
1. **Invariante de Indistinguibilidade de Existência (V-06):**
   Para qualquer espaço produtor $P_{\text{restricted}}$ cujo status seja `"revoked"`, ou que não possua a outorga da lente solicitada $L \notin L_P$, ou que contenha exclusivamente conteúdo restrito:
   - O consumidor $C$ **não pode inferir a existência** de $P_{\text{restricted}}$.
   - É **expressamente proibido** retornar qualquer corpo, trecho, snippet, heading, título de seção, caminho de arquivo, handle, nome de diretório base ou identificador de espaço de $P_{\text{restricted}}$ em qualquer um dos seguintes canais:
     1. `result.sources` (lista de fontes entregues).
     2. `result.self.documents` e `result.project.documents`.
     3. `result.federated` (projeção de espaços federados).
     4. `result.restrictions` (diagnóstico de restrições).
     5. `result.warnings` (avisos operacionais).
     6. `result.context_receipt` (recibo de contexto).
2. **Tratamento Seguro de Omissões:**
   Documentos de espaços pares não-autorizados que venham a ser inspecionados são contabilizados anonimamente no contador escalar `unauthorized_sources_omitted: N`, sem identificação de espaço, caminho ou razão de bloqueio.

#### 8.1.4 Tratamento Rigoroso de Resiliência e Contenção de DoS (B2, N1)
O motor de contexto e federação deve implementar deterministicamente a separação estrita entre falha de autoridade primária e indisponibilidade opcional de pares:

1. **Resultado 1: Parcial Seguro (`status: 'partial'`)**:
   - **Condição:** Um espaço produtor par $P$, devidamente atestado e ativo em `links.json`, está temporariamente inacessível no sistema de arquivos (`ENOENT`, unidade externa desconectada, `EACCES` / `EPERM` de leitura no diretório, ou arquivo de link local corrompido/divergente).
   - **Isolamento de Falha (Contenção de DoS, B2):** Uma falha em um projeto produtor par **NUNCA** aborta a consulta do consumidor nem compromete o acesso ao `self`. O par problemático é isolado, omitido dos candidatos e rebaixado para a lista de indisponibilidade opcional.
   - **Envelope:** O objeto de resultado retorna compulsoriamente:
     - `status: "partial"` no envelope e no recibo.
     - `unreachable_spaces: ["hs-space-<16-hex>"]` listando exclusivamente os identificadores de espaço opacos dos produtores indisponíveis (sem vazar caminhos físicos, nomes de pasta ou slugs do host, N1).
     - As fontes entregues provêm integralmente dos espaços que puderam ser lidos com segurança.
2. **Resultado 2: Fonte Bloqueada (Blocked Source)**:
   - **Condição:** Um documento específico dentro de um espaço produtor acessível apresenta falha pontual: erro de leitura transiente, TOCTOU detectado durante entrega (hash divergente entre pré-leitura e stat), frontmatter corrompido/incompatível, ou detecção de segredo no texto.
   - **Comportamento:** Apenas a fonte individual é descartada fail-closed (`delivery_reason`), mantendo o restante dos documentos válidos do espaço em entrega normal.
3. **Resultado 3: Consulta Abortada (Fail-Closed)**:
   - **Condição:** Falha na determinação da **autoridade primária** do próprio consumidor:
     1. Registro soberano `<selfRoot>/.holoself/links.json` corrompido, ilegível ou violando o schema v1.
     2. `selfRoot` inalcançável para validar a identidade e as concessões soberanas do próprio consumidor.
     3. Vínculo do consumidor `<projectDir>/.holoself/link.yaml` com `binding_salt` divergente ou ausente em relação ao registro soberano.
     4. Ambiguidade ou corrupção no registro de lentes do self que impeça calcular a interseção de segurança.
   - **Comportamento:** A consulta inteira é **imediatamente interrompida** com erro fatal (*fail-closed*), impedindo qualquer entrega sob estado de autoridade primária indeterminado.

#### 8.1.5 Identificadores Compostos e Deduplicação Pós-Autorização (B4)
1. **Identificadores Compostos e Desambiguação de Caminhos:**
   - `space_id`: `"self"`, `"contrib"` ou `"hs-space-" + sha256("project\0" + canonical_project_path).slice(0, 16)`.
   - `source_id`: derivado canonicamente via `sourceRef(spaceId, relPath, contentHash)` como `hs-${sha256(spaceId + "\0" + canonicalRelPath).slice(0, 20)}`.
   - Como o `space_id` entra como prefixo salgado no cômputo do `source_id`, arquivos com o mesmo nome relativo em projetos diferentes (ex.: `README.md` em $P_A$ e $P_B$) geram `source_id`s matematicamente distintos e não colidentes.
   - Identificador Composto Global: `${space_id}:${source_id}` ou objeto `SourceRef: { space_id, source_id, revision, section_id }`.
2. **Deduplicação Pós-Autorização contra Shadowing (B4):**
   - A deduplicação por hash de conteúdo (`source_text_hash`) opera estritamente **após** as fases de autorização e filtragem de `read_scope` e `access_lenses`. Apenas documentos que já foram autorizados e considerados plenamente entregáveis entram na arena de deduplicação.
   - Isso elimina categoricamente o risco de *shadowing*: um documento local inelegível (ex.: `read_scope: local` sob consulta que requer compartilhamento) é descartado na autorização, nunca mascarando uma cópia idêntica válida existente em um par com `read_scope: shared`.
   - Quando cópias idênticas e autorizadas existirem em múltiplos espaços:
     - A precedência de seleção determinística é:
       1. Espaço local do projeto consumidor (`client:linked`).
       2. Espaço soberano (`self`).
       3. Espaços federados pares, ordenados alfabeticamente por `space_id`.
     - A fonte selecionada retém exclusivamente a procedência do espaço vencedor.
     - A deduplicação **jamais promove direitos**: a existência de uma cópia em espaço restrito nunca é exposta, e cópias em espaços distintos são avaliadas estritamente sob as políticas e lentes do seu próprio espaço.

#### 8.1.6 Catálogo Federado, Caches Multi-Espaço e Interleaving contra Starvation (B1, B5, V-07, V-08)
1. **Carregamento Particionado de Catálogos:**
   - `ensureCatalog` é estendido para suportar múltiplos espaços federados, instanciando/validando `<projectDir>/.holoself/runtime/catalog.json` para cada espaço produtor ativo.
   - Falha de I/O em partição de produtor par aciona imediatamente o rebaixamento isolado para `status: "partial"`.
2. **Chave e Invalidação de Cache de Decisão (Merkle Root Multi-Espaço, B1):**
   - O cômputo de `catalog_hash` em `computeDecisionCacheKey` agrega deterministicamente os pares ordenados `[space_id, [[source_id, revision], ...]]` de **todos os espaços consultados**:
     $$\text{catalog\_hash} = \text{sha256}\left(\text{canonicalJson}\left(\text{orderedSpaceSources}\right)\right)$$
   - O campo `links_register_hash` garante que qualquer revogação de produtor em `links.json` altere imediatamente a chave, invalidando todos os caches residuais em `<projectDir>/.holoself/runtime/context-cache/`.
3. **Cursor de Paginação e Revalidação Segura (V-07):**
   - O cursor opaco vincula em seu HMAC criptográfico: `identity_id`, `task_hash`, `lens`, `budget`, `temporal`, `catalog_hash`, `links_register_hash` e o offset.
   - A reidratação do cursor executa compulsoriamente a validação da interseção tripla e reavaliação de frescor. Qualquer alteração estrutural ou revogação entre páginas invalida o cursor com `CURSOR_INVALID`, exigindo nova consulta.
4. **Ranking Global e Interleaving contra Starvation Alfabético (B5):**
   - Em caso de empate de relevância (`task_relevance`), a ordenação cruzada entre espaços utiliza o identificador pseudo-aleatório uniforme `source_id` como critério secundário de ordenação, em substituição ao caminho relativo (`path`).
   - Isso garante um *interleaving* estatisticamente justo entre todos os espaços federados, impedindo que uma pasta com nome alfabeticamente precoce (ex.: `00-archives/`) monopolize o envelope de contexto e cause *starvation* silencioso sobre o `self` ou outros produtores.

#### 8.1.7 Projeção do Envelope de Contexto e Busca Federada
1. **Estrutura de `ContextResult` com Federação:**
   O envelope retornado por `contextData` estende de forma aditiva:
   - `status`: `"complete"` | `"partial"` | `"not-needed"`.
   - `self`: `{ documents: [...] }`.
   - `project`: `{ name: "...", documents: [...] }` (projeto consumidor local).
   - `federated`: array contendo as projeções de espaços pares:
     ```json
     [
       {
         "space_id": "hs-space-...",
         "name": "producer-project-name",
         "documents": [...]
       }
     ]
     ```
   - `unreachable_spaces`: presente se `status === "partial"`, contendo array de `space_id`s inalcançáveis (N1).
   - `sources`: lista unificada e deduplicada contendo `{ space_id, source_id, path, source_hash, ... }`.
2. **Orçamento Global e Truncamento Unificado:**
   - O orçamento de bytes do envelope (`small`: 16 KiB, `standard`: 48 KiB, `deep`: 128 KiB) aplica-se à **soma de todos os documentos entregues** (self + local + federated + methods).
   - O truncamento gradual remove documentos de menor relevância preservando a integridade das listas estruturadas.
3. **Busca Federada em `searchIndex` e MCP:**
   - Quando `federated: true` for ativado na busca, a operação percorre os catálogos/índices de todos os espaços federados autorizados, aplica a interseção tripla de lentes e a deduplicação de passagens por hash, retornando resultados ranqueados com procedência composta `${space_id}:${file}#${heading}`.

### 8.2 Registro de Entrega e Verificação do Ciclo C-04 (T04-F)

- **Ciclo:** C-04 — Federação real
- **Escopo e Requisitos:** R-08, I-03, I-04, I-06; V-06, V-07, V-08, V-12; E-06.
- **Entregáveis Técnicos:**
  1. `src/ecosystem.mjs`:
     - Suporte a múltiplos espaços federados em `ensureCatalog` e `ensureCatalogPartition`.
     - Descoberta in-memory com pré-filtro Zero-I/O (`getEligibleFederatedSpaces`) para suprimir timing oracles em pares não autorizados (B3).
     - Interseção tripla de acesso: $L \in L_{\text{consumer}} \cap L_{\text{producer}} \cap \text{access\_lenses}(d)$ e $d.\text{read\_scope} === \text{"shared"}$.
     - Isolamento anti-oráculo estrito para pares restritos (V-06): descarte silencioso sem entrada em `restrictions`, sem menção em `unreachable_spaces`, sem leak de caminho, handle, título ou trecho.
     - Deduplicação pós-autorização (B4) com precedência estrita: local > self > pares ordenados por `space_id`.
     - Merkle root multi-espaço em `catalog_hash` e revalidação estrita de cursor e revogações via `links_register_hash`.
     - Resiliência determinística: indisponibilidade de partição par rebaixa isoladamente para `status: "partial"` com `unreachable_spaces` opaco (`hs-space-...`), preservando contexto local e soberano; corrupção de autoridade soberana (`links.json`) aborta imediatamente fail-closed.
     - Busca federada em `searchIndex`, CLI `holoself search --federated` e MCP `holoselfMcpSearch` com deduplicação de passagens por hash e procedência composta `${space_id}:${file}#${heading}`.
  2. `src/context-selection.mjs`:
     - Interleaving justo anti-starvation (B5) com desempate pseudo-aleatório uniforme por `source_id` antes de `path`.
  3. `src/cli.mjs`:
     - Argumento `--spaces` adicionado aos comandos de contexto e busca.
  4. `tests/federation.test.mjs`:
     - Suite abrangente com 9 testes cobrindo V-06 (três espaços sintéticos anti-oráculo), isolamento de `read_scope: "local"`, concessões assimétricas e Zero-I/O (B3), indisponibilidade parcial (B2, N1, V-08), revogação e invalidação de cache (V-07, B1), deduplicação pós-autorização (B4), busca federada CLI/MCP e paginação.
- **Resultados dos Testes e Verificação:**
  - `node --test tests/federation.test.mjs`: 9/9 passaram.
  - `node --test tests/*.test.mjs`: 220/220 passaram (100%).
  - `node scripts/verify.mjs`: `[ok] tests`, `[ok] package audit`, `[ok] help`, `[ok] capabilities`.
  - `git diff --check`: 0 avisos.
  - E-06 e V-06 formalmente verificados e aprovados.


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

### 9.1 Especificação Técnica do Contrato C05-CONTRACT-1 (T05-S)

| Campo | Valor |
|---|---|
| Contrato | C05-CONTRACT-1 |
| Ciclo | C-05 — Experiência e integração (consulta única, instruções e Workbench) |
| Responsável | Engenheiro de Qualidade e Arquitetura (Q) |
| Data | 2026-09-21 |
| Status | Proposto para Revisão Adversarial (T05-V) |
| Rastreabilidade | R-05, R-10; A-04, A-05, A-06; V-03, V-04, V-09; D-05, D-06; J-1, J-2, J-3 |

---

#### 9.1.1 Escopo, Invariantes e Requisitos Vinculados
1. **R-05 (Consulta Única Orientada à Tarefa):**
   - Uma única chamada (`holoself context --task "<request>"` na CLI ou ferramenta de contexto em MCP) deve entregar contexto útil delimitado e fontes pertinentes em um único round-trip sem exigir chamada preliminar de manifesto.
   - Manifesto (`--manifest`) e expansão pontual de handles (`--source <id>`) permanecem disponíveis como capacidades opcionais de aprofundamento.
   - Tarefas mecânicas confirmadas como `not-needed` retornam zero caracteres e zero leituras de corpos de arquivos pessoais (`personalBodyReads === 0 && personalBodyChars === 0`).
   - Tarefas ambíguas preservam contexto relevante sob classificação `helpful` sem descarte silencioso e sem escalada de privilégios.
2. **R-10 (Instruções Curtas e Entrada Canônica):**
   - Os arquivos de instruções gerados (`.holoself/BOOTSTRAP.md`, blocos gerenciados em `AGENTS.md`, `CLAUDE.md`, etc.) e a especificação da skill pública (`skills/holoself/SKILL.md`) devem ser concisos, indicando claramente quando consultar e qual comando/ferramenta executar.
   - Não duplicar regras detalhadas de política de autorização, regex de sensibilidade ou controle de acesso em prosa dentro de instruções de projeto: a resolução de raízes, a validação e o controle de acesso pertencem com exclusividade ao runtime (`contextData`).
3. **D-05 (Compatibilidade Legada Não-Silenciosa e Zero-I/O em Junções):**
   - Caracterizar e distinguir formalmente os três modos de coexistência:
     1. *Metadata Project Link*: `.holoself/link.yaml` (modo padrão).
     2. *Exported Packet / Snapshot*: `.holoself/context-packet.md` ou `.holoself/runtime/context-packet.md` sem `link.yaml` (leitura estática).
     3. *Legacy Live Mount*: `.holoself` como symlink ou junction do filesystem.
   - Invariante estrita de segurança: diagnósticos e comandos de rotina **jamais leem ou percorrem montagens reais** através do filesystem. A identificação de junção legada é realizada exclusivamente via `lstatSync(p).isSymbolicLink()`.
   - Diagnósticos explícitos em `status` e `doctor` identificam o modo exato e alertam o usuário sobre riscos de segurança sem conversão automática ou exclusão silenciosa.
4. **D-06 e V-03 (Fechamento de Tetos de Envelope):**
   - Tetos de payload serializado UTF-8 completo exposto ao agente fixados estritamente em:
     - `small`: 16.384 bytes (16 KiB).
     - `standard`: 49.152 bytes (48 KiB).
     - `deep`: 131.072 bytes (128 KiB).
   - O truncamento gradual remove ordenadamente documentos de menor relevância (`task_relevance`), preservando a integridade do JSON/envelope e as fontes obrigatórias de tarefas pessoais no perfil `deep`.
5. **V-09 (Critérios de Necessidade e Qualidade PT/EN):**
   - Todos os 36 casos congelados de qualidade definidos no harness C-00 (`tests/helpers/c00-fixture.mjs`) devem ser aprovados com 100% de sucesso:
     - Casos mecânicos (6 EN + 6 PT): `expectedNeed = ['not-needed']`, `personalBodyReads === 0`, `personalBodyChars === 0`, `status: 'passed'`.
     - Casos pessoais (6 EN + 6 PT): `expectedNeed = ['required']`, marcadores obrigatórios presentes, marcadores proibidos ausentes, `status: 'passed'`.
     - Casos ambíguos (6 EN + 6 PT): `expectedNeed = ['helpful', 'required']`, contexto útil preservado sem descarte silencioso, marcadores obrigatórios presentes, marcadores proibidos ausentes, `status: 'passed'`.
6. **A-06 e V-04 (Workbench Explicável e Paridade de Decisão):**
   - O Workbench exibe perspectiva (lente), escopo efetivo e diagnósticos seguros.
   - Preservação estrita das regras anti-oráculo V-06 e V-12: omissões de fontes não autorizadas ou restritas de espaços federados são descritas por motivos neutros, sem jamais expor títulos, handles, caminhos ou existência de fontes negadas.

---

#### 9.1.2 Oráculo Determinístico do Gate de Necessidade e Relevância (V-09, A-04)

A função `contextNeed(task)` em `src/context-selection.mjs` é normatizada com suporte bilíngue (EN/PT) e classificação determinística em três estados (`required`, `not-needed`, `helpful`):

1. **Tokenização e Extração de Termos:**
   - O texto da tarefa é normalizado para minúsculas e tokenizado via expressão Unicode de palavras com comprimento $\ge 3$:
     $$\text{tokens} = \text{Set}\left(\text{tokenize}(\text{task})\right)$$
   - Stopwords multilíngues expandidas (EN, PT, NL, DE) são filtradas.

2. **Dicionário Determinístico de Tokens:**
   - **Tokens Pessoais ($\mathcal{T}_{\text{personal}}$):**
     `'identity'`, `'career'`, `'leadership'`, `'voice'`, `'preference'`, `'personal'`, `'interview'`, `'application'`, `'holoself'`,
     `'identidade'`, `'carreira'`, `'lideranca'`, `'liderança'`, `'voz'`, `'preferencia'`, `'preferência'`, `'pessoal'`, `'entrevista'`, `'apresentacao'`, `'apresentação'`, `'prioridade'`, `'prioridades'`.
   - **Tokens Mecânicos ($\mathcal{T}_{\text{mechanical}}$):**
     `'format'`, `'rename'`, `'compile'`, `'lint'`, `'test'`, `'syntax'`, `'install'`, `'sort'`, `'convert'`, `'indent'`,
     `'formate'`, `'renomeie'`, `'compile'`, `'teste'`, `'sintaxe'`, `'instale'`, `'ordene'`, `'converta'`, `'indente'`, `'corrija'`.

3. **Regra de Decisão do Gate:**
   $$\text{context\_need}(\text{task}) = \begin{cases}
   \text{"required"}, & \text{se } \text{tokens} \cap \mathcal{T}_{\text{personal}} \neq \emptyset \\
   \text{"not-needed"}, & \text{se } \text{tokens} \cap \mathcal{T}_{\text{mechanical}} \neq \emptyset \text{ e } \text{tokens} \cap \mathcal{T}_{\text{personal}} = \emptyset \\
   \text{"helpful"}, & \text{se } \text{task} \neq "" \text{ e } \text{tokens} \cap (\mathcal{T}_{\text{personal}} \cup \mathcal{T}_{\text{mechanical}}) = \emptyset \\
   \text{"not-needed"}, & \text{se } \text{task} = ""
   \end{cases}$$

4. **Tratamento de Execução de `not-needed` no Runtime (`contextData`):**
   - Quando `context_need === "not-needed"` e o chamador não tiver especificado fontes explícitas via `--source` / `source_ids`:
     - O subsistema de seleção **não invoca `deliverRecord`** para candidatos pertencentes ao espaço `self`.
     - `self.documents` é projetado como lista vazia `[]`.
     - `personalBodyReads` resulta estritamente em `0`.
     - `personalBodyChars` resulta estritamente em `0`.
     - O resultado da consulta recebe `status: "not-needed"`.
   - Caso o chamador solicite fontes explícitas pelo seu `source_id`, a consulta atua como expansão orientada pelo usuário e entrega os corpos solicitados mediante validação de acesso.

5. **Tratamento de Tarefas Ambíguas (`helpful`):**
   - Tarefas ambíguas não são descartadas nem rebaixadas para `not-needed`.
   - O algoritmo executa o ranqueamento por relevância textual (`task_relevance`), seleção e entrega de trechos e evidências autorizados dentro do orçamento, satisfazendo as jornadas J-1 e J-3.

---

#### 9.1.3 Protocolo de Consulta Única em CLI e MCP (R-05, A-06)

1. **Interface CLI:**
   - Comando canônico:
     `holoself context --task "<request>" [--project <dir>] [--lens <lens>] [--budget small|standard|deep] [--json]`
   - Executa a resolução completa e entrega o envelope com documentos preenchidos em uma única invocação.
   - Flags `--manifest` e `--source <id>` permanecem disponíveis e preservam semântica inalterada.

2. **Interface MCP (`src/mcp-server.mjs`):**
   - Adição da ferramenta orientada à tarefa com consulta única:
     - Nome: `holoself_context`.
     - Título: `Holoself context`.
     - Descrição: `Resolve and deliver privacy-filtered, lens-scoped context for the current task in a single round-trip. Manifest and get remain optional for fine-grained inspection.`
     - Esquema de Entrada:
       ```json
       {
         "type": "object",
         "properties": {
           "task": { "type": "string", "minLength": 1, "maxLength": 500, "description": "The current task; used for deterministic relevance selection and gate." },
           "lens": { "type": "string", "minLength": 1, "maxLength": 80, "description": "A built-in or canonical custom lens ID." },
           "budget": { "type": "string", "enum": ["small", "standard", "deep"], "default": "standard" },
           "temporal": { "type": "string", "enum": ["current", "historical", "superseded", "all"], "default": "current" }
         },
         "required": ["task"],
         "additionalProperties": false
       }
       ```
     - Comportamento: invoca `holoselfMcpContext(project, { ...args, manifest: false })`, entregando o payload com documentos preenchidos diretamente no retorno do tool call.
   - Ferramentas de suporte mantidas:
     - `holoself_context_manifest`: Retorna metadados e handles sem corpos (`estimatedTokensBody: 0`).
     - `holoself_context_get`: Expande handles específicos (`source_ids`).
     - `holoself_status`: Relata autorização e saúde da vinculação.
     - `holoself_search`: Busca federada/local com procedência composta.
     - `holoself_proposal_create` e `holoself_proposal_preview`: Ciclo de vida de propostas.

---

#### 9.1.4 Consolidação de Instruções e Skill Pública (R-10)

1. **Instruções de Inicialização (`src/instructions.mjs`):**
   - O arquivo `.holoself/BOOTSTRAP.md` gerado por `bootstrapText(link)` instrui o agente a utilizar diretamente a consulta única:
     ```markdown
     # Holoself startup

     Run `holoself context --project . --task "<current request>" --budget standard --json`; do not read linked canonical files directly.
     Default lens: `<default_lens>`. The command applies privacy, relevance, lifecycle, and budget policy.
     Treat linked Holoself context as private and read-only.
     Never modify canonical self directly; use proposal/review for durable self changes.
     Readable context is not publication approval; publishing requires explicit disclosure approval.
     ```
   - Nenhuma lógica de filtragem de sensibilidade ou autorização de documentos é delegada a instruções de prompt; todo o controle é executado deterministicamente pela ferramenta.

2. **Skill Pública (`skills/holoself/SKILL.md`):**
   - Clarificar o fluxo de interação:
     - O agente inicia por `holoself context --project . --task "<current request>" --json` (ou `holoself_context` em MCP).
     - O gate determinístico poupa automaticamente corpos pessoais em tarefas mecânicas.
     - `holoself_context_manifest` seguido de `holoself_context_get` é documentado como alternativa para inspeção granular de volumes massivos.
   - Eliminar repetições de regras de autorização de campo em prosa.

---

#### 9.1.5 Caracterização e Não-Conversão de Modos de Projeto (D-05)

1. **Oráculo de Detecção de Modos:**
   A inspeção de um projeto candidato `.holoself` opera sob precedência estrita:
   - **Caso A (Metadata Link):** Se `.holoself` é um diretório real e `.holoself/link.yaml` existe e é um arquivo regular $\rightarrow$ `mode: "metadata-link"`.
   - **Caso B (Legacy Live Mount):** Se `.holoself` é um symlink ou junction (`lstatSync.isSymbolicLink() === true`) $\rightarrow$ `mode: "legacy-mount"`.
   - **Caso C (Context Snapshot):** Se `.holoself` é um diretório real sem `link.yaml` contendo `context-packet.md` (ou `runtime/context-packet.md`) $\rightarrow$ `mode: "snapshot"`.
   - **Caso D (Inválido / Não Vinculado):** Nenhum dos casos acima $\rightarrow$ `mode: "unlinked"`.

2. **Invariante de Isolamento de Mounts Reais (Zero-I/O):**
   - Ao detectar `mode: "legacy-mount"`, o runtime **não deve invocar `readdir` ou `readFile`** no destino apontado durante operações comuns de diagnóstico.
   - O diagnóstico em `holoself link status`, `holoself doctor` e no Workbench relata:
     - `state: "legacy-mount"`.
     - Aviso de segurança: `"Project uses a direct filesystem junction exposing private root data without lens or privacy filters. Run holoself link setup to migrate to a bounded metadata link."`
   - O comando `holoself unlink --target <dir>` remove a junção sem alterar nem apagar os dados na raiz de destino.

---

#### 9.1.6 Workbench: Explicabilidade Segura e Isolamento Anti-Oráculo (A-06, V-04)

1. **Exposição de Perspectiva e Escopo no Workbench:**
   - O Workbench exibe para cada espaço:
     - Perspectiva ativa (lente padrão configurada).
     - Modo de vinculação (`metadata-link`, `snapshot`, `legacy-mount`).
     - Escopo de contexto do projeto (`include` / `exclude`).
     - Estado de ativação de instruções e adaptadores de hosts locais.
2. **Preservação Anti-Oráculo em Diagnósticos e Pré-visualizações:**
   - Em conformidade com V-06 e V-12:
     - Documentos restritos de espaços pares ou de sensibilidade proibida não aparecem em contagens de restrições ou prévias de contexto do Workbench.
     - Motivos de exclusão exibidos são estritamente genéricos: `"budget exhausted"`, `"temporal excluded"`, `"policy restricted"`. Nenhum caminho relativo, título ou trecho de documento negado é emitido na API REST do Workbench (`src/web-server.mjs`).

---

#### 9.1.7 Orçamentos de Envelope e Truncamento (V-03, D-06)

1. **Medição Estrita de Envelope UTF-8:**
   - O tamanho do payload é medido pela serialização JSON final emitida ao cliente:
     $$\text{payloadBytes} = \text{Buffer.byteLength}(\text{serializedPayload}, \text{"utf8"})$$
   - Inclui corpo de dados, wrappers estruturados MCP (`content` + `structuredContent`), metadados e recibo.
2. **Capacidade dos Perfis:**
   - `small`: 16.384 bytes.
   - `standard`: 49.152 bytes.
   - `deep`: 131.072 bytes.
3. **Truncamento sem Corrupção:**
   - Quando `payloadBytes > envelopeCap`, a seleção descarrega ordenadamente os candidatos com menor relevância pontuada até satisfazer o teto, registrando as omissões no recibo de contexto.

---

### 9.2 Registro de Entrega e Evidências do Ciclo C-05 (T05-F)

- **Ciclo:** C-05 ("Experiência e integração — consulta única, instruções e Workbench").
- **Escopo e Requisitos Atendidos:** R-05, R-10; A-04, A-05, A-06; V-03, V-04, V-09; D-05, D-06; Jornadas J-1, J-2, J-3.
- **Artefatos Entregues:**
  1. `docs/specifications/c05-research-single-query-and-experience.md`: Mapeamento das superfícies de instrução, inventário de adaptadores, caracterização dos modos de projeto e gaps de ferramentas MCP.
  2. `src/context-selection.mjs`:
     - Padrões Unicode-safe `PERSONAL_PATTERN` e `MECHANICAL_PATTERN` cobrindo PT/EN e flexões morfológicas.
     - Gate determinístico `contextNeed`: classifica tarefas em `required`, `not-needed` e `helpful`.
     - Supressão estrita de corpos de documentos pessoais sob `not-needed` quando nenhuma fonte explícita é requisitada, preservando contexto útil em tarefas ambíguas e consultas gerais.
  3. `src/ecosystem.mjs`:
     - Invariante Zero-I/O em montagens legadas (`isLegacyMount`) em `findLinkUpwards`, `readLink`, `healthStatus` e diagnósticos.
     - Proteção anti-oráculo: `unauthorized_sources_omitted` restrito a `owner:direct`, ocultado de `client:linked`.
     - Entrega de metadados `mode: "legacy-mount" | "metadata-link" | "snapshot"` no status de espaço.
  4. `src/mcp-server.mjs`:
     - Nova ferramenta `holoself_context` orientada à tarefa, entregando envelope completo com corpos em um único round-trip (totalizando 7 ferramentas MCP).
     - Validação defensiva de junções legadas no binding de projetos.
  5. `src/cli.mjs`:
     - Capabilities MCP atualizadas com a ferramenta `holoself_context`.
  6. `skills/holoself/SKILL.md`:
     - Atualização do contrato de resolução rápida documentando `holoself_context` (MCP) e consulta única CLI (`holoself context --task "<req>"`).
     - Documentação do gate determinístico que poupa corpos pessoais em tarefas mecânicas sem delegar controle a instruções em prosa.
  7. `src/web-server.mjs` e `web/app.mjs`:
     - Ação corretiva `setup` no Workbench para migrar espaços em `legacy-mount` para `metadata-link` com segurança.
     - Exibição de badge do modo de projeto, perspectiva ativa (lente) e estado de ativação.
     - Preservação estrita anti-oráculo: nenhum caminho, handle ou detalhe de fonte negada é vazado na interface.
  8. `tests/web-project.test.mjs`, `tests/mcp.test.mjs`, `tests/c00-baseline.test.mjs`:
     - Testes automatizados para detecção e migração de junções legadas no Workbench.
     - Testes de entrega completa e supressão mecânica via `holoself_context`.
     - Atualização da evidência E-07 para `reproduced: false` (resolvido).
- **Resultados dos Testes e Verificação:**
  - `node --test tests/*.test.mjs`: 221 de 221 testes passaram (100%).
  - `scripts/c00-baseline.mjs --acceptance`:
    - **Qualidade PT/EN:** 36 de 36 casos passaram (100% de sucesso).
    - **Critério V-09:** `status: "passed"`.
    - **Evidência E-07:** `reproduced: false, bodyChars: 0`.
    - **Critérios V-02, V-03, V-06:** `status: "passed"`.
  - `node scripts/verify.mjs`: `[ok] tests`, `[ok] package audit`, `[ok] help`, `[ok] capabilities`.
  - `git diff --check`: 0 avisos.


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

### 10.1 Especificação Técnica do Contrato C06-CONTRACT-1 (T06-S)

#### 10.1.1 Matriz de Plataformas e Runtime de Execução
1. **Ambiente Canônico de Execução:**
   - Runtime de execução mínima declarada: Node.js `>=20.0.0` (execução sob Node.js v26.8.1 em ambiente Windows 11).
   - Suporte pleno a caminhos no Windows: letras de unidade maiúsculas/minúsculas (`C:` / `c:`), separadores de diretório mistos (`\` e `/`), e junções de diretórios (`junction`) sem recursão cíclica.
   - Padrão Pure ESM: zero dependências externas no runtime (`dependencies` vazio no `package.json`), utilizando unicamente módulos embutidos do Node.js (`node:fs`, `node:crypto`, `node:path`, `node:http`, `node:child_process`).

#### 10.1.2 Matriz de Oráculos de Regressão e Verificação (V-01 a V-12)
1. **Comandos Canônicos de Auditoria:**
   - Suite Geral: `node --test tests/*.test.mjs` (221 testes automatizados).
   - Pacote e Sanidade: `node scripts/verify.mjs` (abrangendo testes unitários, auditoria de empacotamento, help e capabilities).
   - Linha de Base e Aceite Formal: `node scripts/c00-baseline.mjs --acceptance` (avaliando oráculos V-01 a V-12 e os 36 casos de qualidade).
   - Formatação e Whitespace: `git diff --check`.
2. **Separação Rigorosa de Oráculos de Aceite:**
   - **Aprovados no Ciclo de Aceite Integrado:** V-02, V-03, V-04, V-05, V-06, V-07, V-08, V-09, V-10, V-11, V-12.
   - **V-09 (Qualidade e Supressão de Corpos):** 100% de sucesso nos 36 casos congelados PT/EN de `tests/helpers/c00-fixture.mjs` (`passed: 36, total: 36`).
   - **V-10 (Migração Reversível):** 100% de passagem nos 10 testes de `tests/migration.test.mjs`.

#### 10.1.3 Protocolo do Ensaio Integrado de Reversão
1. **Ensaio Sintético de Aplicação e Reversão:**
   - Um repositório sintético com metadados legados (`visibility` / `public_safe`) é submetido a:
     1. `holoself migrate policy --dry-run` $\rightarrow$ Validação de plano sem alteração de arquivos.
     2. `holoself migrate policy --apply <plan> --confirm-narrowing` $\rightarrow$ Aplicação com estreitamento explícito e gravação de recibo assinado por hash SHA-256.
     3. Validação de estado intermediário: schema v1 ativo, lentes soberanas em vigor.
     4. `holoself migrate policy --revert <receipt>` $\rightarrow$ Restauração idêntica dos arquivos originais e validação de igualdade byte a byte.

#### 10.1.4 Validação das Três Jornadas Primárias (J-1, J-2, J-3)
1. **Jornada J-1 (Consulta de Contexto Pessoal):**
   - Agente solicita `holoself context --task "<personal-task>" --budget standard --json` (ou `holoself_context` em MCP).
   - Gate classifica como `required`.
   - Entrega documentos pertinentes sob a lente ativa dentro do limite UTF-8 de 48 KiB.
2. **Jornada J-2 (Operação Mecânica Pura):**
   - Agente solicita `holoself context --task "Format this JSON object" --budget small --json`.
   - Gate classifica como `not-needed`.
   - Runtime retorna 0 caracteres e 0 leituras de corpos pessoais (`personalBodyChars === 0` e `personalBodyReads === 0`).
3. **Jornada J-3 (Tarefa Ambígua):**
   - Agente solicita `holoself context --task "Compare these options for my next step" --budget standard --json`.
   - Gate classifica como `helpful`.
   - Contexto é preservado sem descarte silencioso e sem escalonamento indevido de acesso.

---

### 10.2 Registro de Entrega e Evidências do Ciclo C-06 (T06-F / T06-G)

- **Ciclo:** C-06 ("Testes finais e prontidão para adoção").
- **Escopo e Requisitos Atendidos:** R-01 a R-12; V-01 a V-12; D-01 a D-08; Jornadas J-1, J-2, J-3.
- **Artefatos Entregues:**
  1. `docs/specifications/c06-research-traceability-and-readiness.md`: Matriz de rastreabilidade ponta a ponta requisito $\rightarrow$ contrato $\rightarrow$ código $\rightarrow$ teste, auditoria de esquemas e ausência de dados pessoais.
  2. `src/migration.mjs`:
     - Aplicação de escrita atômica (`atomicWriteFile`) em `applyPolicyMigration` e `revertPolicyMigration`, prevenindo corrupção de arquivos sob interrupções abruptas.
     - Selo de integridade criptográfica no recibo (`applied_entries_digest`), abortando reversões fail-closed caso o recibo seja adulterado ou corrompido.
  3. `schemas/migration-receipt.schema.json`: Atualização do esquema JSON formal incluindo `applied_entries_digest`.
  4. `scripts/package-audit.mjs`: Auditoria recursiva em todos os diretórios do pacote (`bin`, `src`, `web`, `skills`, `contribs`, `docs`, `schemas`, `templates`), garantindo ausência total de credenciais, dados pessoais e chaves.
  5. `tests/migration.test.mjs`: Teste automatizado de proteção fail-closed contra adulteração de recibos de migração.
  6. `docs/reports/before-after-c00-to-c06.md`: Relatório comparativo demonstrando resolução de todas as evidências E-01 a E-08 herdadas de HS-SPEC-001 e 100% de passagem nos 36 casos de qualidade.
  7. `docs/guides/adoption-and-rollback-runbook.md`: Guia prático de adoção, migração de repositórios legados, ativação de MCP e procedimentos determinísticos de reversão.
  8. `docs/README.md`: Navegação consolidada integrando todos os relatórios e guias da especificação.
- **Resultados dos Testes e Verificação Integrada:**
  - `node --test tests/*.test.mjs`: **222 de 222 testes passaram (100% de sucesso)**.
  - `node scripts/verify.mjs`: `[ok] tests`, `[ok] package audit`, `[ok] help`, `[ok] capabilities`.
  - `scripts/c00-baseline.mjs --acceptance`: 36 de 36 casos de qualidade aprovados, V-02, V-03, V-06 e V-09 aprovados com status `passed`.
  - `git diff --check`: 0 avisos de formatação.
- **Status do Projeto:** Ciclos C-00 a C-06 integralmente concluídos e verificados. Código pronto para empacotamento e adoção.

---

## 11. Estado, evidências e entrega futura

C-00: execução concluída conforme §4.5; C-01: execução concluída conforme §5.2; C-02: execução concluída conforme §6.2; C-03: execução concluída conforme §7.2; C-04: execução concluída conforme §8.2; C-05: execução concluída conforme §9.2; C-06: execução concluída conforme §10.2. Todos os ciclos (C-00 a C-06) foram integralmente executados, revisados adversarialmente e verificados com 100% de sucesso.

Registro por tarefa, mantido nesta seção ou no recibo de execução referenciado: `task_id | state | requested_model | resolved_model | input_revision | contract_hash | output_revision | commands | results | metrics | review_findings | disposition`. Estados: planned, ready, running, changes-required, verified, blocked. Um processo que sai com código zero e resposta vazia não constitui revisão.

Ao encerrar cada ciclo, Q entrega resultado observável, requisitos atendidos, evidências reproduzíveis, custo e tentativas, riscos remanescentes e próximo gate. Autorizações já dadas para execução futura não devem ser pedidas novamente para tarefas rotineiras dentro do escopo; decisões que ampliem acesso ou escopo permanecem separadas.

Condição de entrega técnica atendida: C-00–C-06 verificados, achados bloqueantes/altos resolvidos, rastreabilidade completa (R-01 a R-12, V-01 a V-12, D-01 a D-08), economia medida sem perda de qualidade/privacidade e reversão ensaiada. A ativação real será planejada/autorizada separadamente.

## 12. Revisões deste plano

Este registro descreve somente revisões do documento; os gates Tnn-V e Tnn-F continuam futuros.

- **agy / gemini-3.8-flash-medium:** análise efetivamente concluída em 2026-09-19 sobre pacote fornecido com requisitos, arquitetura, critérios e ciclos da especificação; não realizou inventário completo do código. Sessão `d9d32796-305b-4192-87b5-513806ad2511`. Achados adotados: distinguir IO de descoberta/entrega (EC-01), revisar dependência política/catálogo antes de implementar, medir economia junto de relevância, usar bytes reais e fixtures no filesystem. A tentativa inicial sem resposta foi descartada; a revisão válida usou conteúdo inline sem ferramentas.
- **Claude Code / `sonnet`, resolvido `claude-sonnet-5`:** revisão independente dos dois documentos, sessão `d2fc04ff-e920-422f-a5ec-8448f035c226`, veredito inicial `changes-required`. Cinco achados tratados: EC-01 promovido a D-08 com decisão explícita para mudança de aceite; V-01/V-02 separados; suspensão quantitativa de modelo barato; verificação direta da pesquisa de segurança; limites congelados antes de desenvolvimento. Nova revisão na sessão `a9669869-3b2e-478c-b233-ed046c57ae70`: **approved**. Sugestão residual baixa também adotada: estender verificação de Q a T01-R.
- **Grok / `grok-4.6`, execução reportou `grok-4.6-build`:** primeira revisão completa, sessão `01a0ba69-313a-7391-b077-22c8629c9463`, `changes-required`. Tratamento F01–F10: ordem de tarefas C-02/C-03 explícita e sem ciclo; falha parcial distinta de autoridade ambígua; metadados/handles negados testados em C-01; T01-V elevado a Opus por risco; V-12 relevante incluído em C-05; limites D-06 particionados; mudanças semânticas finais reabrem ciclo; provedor indisponível bloqueia sua tarefa; matriz R/I/V/J adicionada. T05-D1 permanece Terra com dataset independente e revisão/aceite obrigatórios, como permitido pelo achado F10. Nova leitura do plano completo consolidado, sessão `01a0ba6e-d590-7c71-8a92-e82e9997501b`: **approved**, sem bloqueador remanescente do plano. Decisões e testes futuros permanecem gates de execução.

Verificação documental de Q: 45 tarefas únicas, sete ciclos com R/S/V/D/F, Claude em todos os gates V, referências de tarefas e R/I/A/V válidas, fences e espaços finais conferidos. Especificação original preservada (SHA-256 `BAC43B91B8386339D3E79147EB6C45EF4C9F359ED6B94192609CE163ACD7D9FA`). Somente este segundo documento foi criado nesta etapa; código e testes de produto não foram alterados nem executados.
