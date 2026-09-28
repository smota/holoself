# Plano de desenvolvimento de fontes externas e coaching

Data: 2026-09-28. Estado: proposta para revisão; implementação não iniciada.

Modelo de execução proposto: [orquestração do épico completo com Codex e Claude CLI](external-sources-and-coaching-orchestration.md). A matriz de modelos e os gates desse documento detalham este breakdown sem iniciar sua execução.

## Registro do backlog

Backlog registrado no GitHub segundo os padrões de issues do AgentFlow, checkout `5438715`. Isso não configura nem certifica adoção integral do framework neste repositório. Issues permanecem abertas, com autoria `drafted-by:codex`; perfis são propostas para confirmação antes da execução.

Épico: [#8 — Fontes externas e coaching reutilizável](https://github.com/smota/holoself/issues/8).

| Marco | Entregas registradas |
|---|---|
| M0 — Contrato viável | [D00 / #9](https://github.com/smota/holoself/issues/9), [D01 / #10](https://github.com/smota/holoself/issues/10) |
| M1 — Fontes verificáveis | [D02 / #11](https://github.com/smota/holoself/issues/11), [D03 / #12](https://github.com/smota/holoself/issues/12), [D04 / #13](https://github.com/smota/holoself/issues/13), [D05 / #14](https://github.com/smota/holoself/issues/14) |
| M2 — Conhecimento revisável | [D06 / #15](https://github.com/smota/holoself/issues/15), [D07 / #16](https://github.com/smota/holoself/issues/16), [D08 / #17](https://github.com/smota/holoself/issues/17), [D09 / #18](https://github.com/smota/holoself/issues/18) |
| M3 — Coaching utilizável | [D10 / #19](https://github.com/smota/holoself/issues/19), [D11 / #20](https://github.com/smota/holoself/issues/20) |
| M4 — Entrega do produto | [D12 / #21](https://github.com/smota/holoself/issues/21) |

Dependências estão nos corpos das issues; o épico mantém a lista de acompanhamento e as relações de sub-issues. O registro autoriza o planejamento do backlog, sem iniciar implementação ou atribuir release. O hash citado nas issues identifica o snapshot anterior a esta seção de rastreabilidade.

## Objetivo e aceite

Permitir que qualquer usuário incorpore fontes externas ao Holoself com fidelidade, proveniência e controle de acesso, consulte esse material em profundidade e aprove aprendizados reutilizáveis. Coaching será a primeira capacidade consumidora dessa infraestrutura.

O produto preserva três camadas: original, representação consultável e conhecimento aprovado. Registros de coaching constituem estado de trabalho explícito; não adquirem autoridade sobre o perfil por serem persistidos.

Critérios de aceite do desenvolvimento completo:

- PDF, DOCX e Markdown têm incorporação local, cobertura registrada e referências verificáveis ao original.
- Extração parcial, fidelidade conferida e aprovação de conhecimento são estados independentes.
- Fontes, fragmentos, imagens derivadas, índices, caches e sínteses obedecem às permissões aplicáveis; metadados negados também não vazam.
- Consulta padrão mantém seu comportamento anterior. Fontes externas exigem seleção explícita e autorização.
- Propostas ligam cada aprendizado à revisão da fonte e ao trecho usado; aprovação continua humana.
- Uma questão de coaching pode ser retomada com evidências, ação escolhida e revisão do resultado.
- Fixtures genéricas e sintéticas demonstram o fluxo; nenhum dado pessoal entra no pacote ou nos testes.

## Base verificada no repositório

| Evidência | Consequência para o plano |
|---|---|
| [Arquitetura](../architecture.md) e [ownership](../concepts/ownership.md) | Markdown aprovado permanece autoridade; artefatos operacionais têm propriedade separada |
| `src/ecosystem.mjs`, funções `canonicalFiles`, `contextData`, `sourceRecords` e fluxo de propostas | Integrar seleção e revisão existentes; não criar um segundo mecanismo de aprovação |
| `src/catalog.mjs`, `sourceRef`, catálogo v2 e cache v3 | Reutilizar hashes, referências e primitivas atômicas após verificar compatibilidade; não assumir que identidade baseada em caminho resolve movimentações |
| `src/context-selection.mjs` | Preservar orçamento de contexto e seleção delimitada |
| `src/documents.mjs` | Editor atual trabalha com Markdown em raízes permitidas; não é importador de PDF/DOCX |
| `schemas/proposal.schema.json` | Compatibilidade com propostas existentes é requisito de qualquer extensão de proveniência |
| `src/mcp-server.mjs` | MCP atual é vinculado ao projeto e não concede aprovação nem escrita canônica |
| `src/web-server.mjs`, `web/app.mjs` | Workbench será outra interface dos mesmos casos de uso |
| `contribs/catalog.json` | Métodos de coaching já existem; ciclo de sessões e acompanhamento é novo |
| `package.json`, [desenvolvimento](../contributing/development.md), `scripts/verify.mjs` | Node >=20; testes, auditoria de pacote, help e capabilities são gates existentes |

A revisão conceitual anterior com Grok favoreceu incorporação antes de coaching e recomendou reduzir a ontologia inicial. Foi uma crítica da proposta, sem inspeção do código; não representa aprovação da implementação nem comprovação de comportamento atual.

## Perguntas bloqueantes

Nenhuma para este breakdown. As decisões técnicas abaixo são hipóteses a validar em D00/D01. Os nomes de comandos, módulos, esquemas e diretórios novos neste documento são propostas, não interfaces já disponíveis.

## Hipóteses e limites

1. **Dados:** v1 cobre arquivos locais PDF, DOCX e Markdown. Limites iniciais propostos: 50 MiB por arquivo, 200 páginas por PDF, 200 MiB descompactados e 10.000 entradas por DOCX. D01 mede e confirma limites antes de congelá-los. Arquivos cifrados, corrompidos, com macros ou sem texto retornam estado explícito; não são considerados capturados com fidelidade.
2. **Fidelidade:** imagens e gráficos são preservados/referenciados e podem exigir conferência humana. OCR e interpretação automática de gráficos são extensões posteriores. O produto não promete extração semântica completa desses elementos no MVP.
3. **Falhas:** extração usa tempo e memória limitados; timeout gera resultado incompleto ou falha identificada, nunca sucesso integral. Dependência ausente não dispara instalação silenciosa nem envio remoto.
4. **Fronteiras:** CLI primeiro, depois MCP e Workbench sobre os mesmos casos de uso. Sem dependência obrigatória de modelo remoto; agentes externos propõem interpretações.
5. **Estado:** registro é idempotente por operação e revisão; conteúdo igual não apaga diferenças de autoria ou contexto entre fontes. Escritas usam revisão esperada e publicação atômica; leitores nunca recebem uma extração parcialmente publicada.
6. **Ambiente:** preservar Node >=20 e funcionamento em Windows, Linux e macOS. Ferramentas nativas opcionais têm detecção e erro acionável. Não acoplar o produto ao runtime do ambiente de desenvolvimento.
7. **Escopo:** sem conectores cloud, observação automática de pastas, migração de acervos pessoais, diagnóstico, ranqueamento de pessoas ou gerenciamento completo de programas de coaching. Não criar nova lente obrigatória.
8. **Testes:** usar corpus sintético com resultados esperados revisados. Validar semântica e permissões, não apenas snapshots produzidos pelo próprio extrator. Acervos reais só em piloto privado posterior, fora do pacote.

## Contrato de informação proposto

### Entidades mínimas

- **Source:** identidade estável, rótulo, localização autorizada, autoria declarada/desconhecida, tipo e política. Nomes de arquivo e datas de modificação não comprovam autoria nem data do evento.
- **SourceRevision:** hash dos bytes, tamanho, data de captura, data do documento/evento quando conhecida e relação explícita com revisões anteriores. Original referenciado permanece controlado pelo usuário; snapshot imutável local exige opção explícita. Se os bytes desaparecerem, a disponibilidade histórica deve ser marcada como perdida.
- **Extraction:** revisão de origem, extrator/versão/configuração, blocos, relatório de cobertura e integridade. É derivada e pode ser reconstruída; conferências humanas precisam de registro durável separado.
- **EvidenceBlock:** tipo, conteúdo, localização e relações: pergunta/resposta, cabeçalho/célula, legenda/figura, autor/fala. PDF usa página e posição quando disponível; DOCX usa seção/parágrafo/tabela/célula, sem inventar paginação estável.
- **Interpretation:** hipótese ou síntese atribuída a autor/agente, com fontes, limites, contrapontos e estado de revisão. Não é autoaprovada pela existência de referências.
- **Coaching record:** questão, sessão, ação e revisão, relacionados por IDs. Intenção, execução relatada e resultado verificado permanecem separados.

### Estados independentes

- Fonte: registrada, indisponível ou retirada da consulta; revisões anteriores continuam identificáveis.
- Extração: pendente, completa, parcial, falhou ou desatualizada.
- Fidelidade: não conferida, conferida ou requer correção, com granularidade de bloco.
- Conhecimento: interpretação candidata ou proposta; aprovação/rejeição/deferimento reutilizam o ciclo existente.

Completude significa que todas as unidades detectadas foram contabilizadas, incluindo as não extraídas. Não significa que seu conteúdo foi compreendido. Blocos visuais podem constar como preservados e ainda não interpretados.

## Breakdown por entregas

Tamanho relativo: S = mudança pequena e delimitada; M = vários componentes; L = incerteza ou integração ampla. Não são estimativas em dias. Dividir L em PRs menores após o spike; a entrega só fecha com o comportamento completo.

| ID | Comportamento entregue e tarefas | Aceite observável | Teste | Tamanho / impacto | Dependências |
|---|---|---|---|---|---|
| D00 | Definir contratos, estados, propriedade, permissões e ADRs; construir corpus sintético com gabarito de cobertura | Matriz fonte/extração/aprovação sem promoção implícita; cada requisito ligado a caso do corpus; storage e política de consulta decididos | Revisão de contrato e fixtures | M / contratos públicos | — |
| D01 | Spike executável: comparar extração local de um PDF complexo e um DOCX complexo; medir estrutura, tabelas, figuras, notas e limites; escolher dependências | Relatório reproduzível com acertos, perdas, recursos, licença/distribuição e decisão; nenhuma limitação encoberta | Experimento e comparação manual com gabarito | M / dependências e portabilidade | D00 |
| D02 | Registrar, inspecionar e retirar fonte via CLI; prévia de caminhos/política; versões por hash; preservar originais | Repetir registro não duplica revisão; retirar impede consulta e conserva arquivo; original alterado cria revisão; escapes e links indevidos recusados | Unitário e integração CLI | M / filesystem e registros | D00, D01 |
| D03 | Extrair Markdown e DOCX para blocos; preservar hierarquia, perguntas/respostas, tabelas, links, imagens e anotações suportadas; contabilizar elementos não suportados | 100% das unidades do gabarito contabilizadas; relações suportadas corretas; truncamento/macro/arquivo inválido nunca reportado como completo | Integração com fixtures e inspeção visual selecionada | L / extratores | D02 |
| D04 | Extrair PDF por página, preservar coordenadas disponíveis, tabelas e referências visuais; detectar texto ausente e ordem ambígua | Nenhuma página omitida sem registro; células verificadas no corpus; scan e gráfico não interpretado visíveis no relatório; extração dentro dos limites | Integração, falhas e inspeção visual | L / parser e recursos | D01, D03 |
| D05 | Oferecer mapa e relatório de cobertura; conferir/corrigir blocos; invalidar derivados por mudança de fonte ou política | Conferência vinculada à revisão exata; correções não alteram original; mudança invalida conferência pertinente; evidência parcial permanece identificada | Unitário, integração e concorrência | M / integridade e ciclo de vida | D03, D04 |
| D06 | Consultar fontes autorizadas explicitamente por CLI, de mapa a trecho; integrar orçamento, catálogo e cache; conservar contexto adjacente e atribuição | Consulta padrão inalterada; consulta explícita respeita orçamento; nenhum metadado/conteúdo negado; referências resolvem; falha ao obter contexto necessário é declarada | Integração, privacidade e regressão | L / recuperação compartilhada | D05 |
| D07 | Criar síntese candidata e proposta com proveniência por afirmação; validar revisão/fidelidade e integrar aprovação existente | Criar proposta não altera contexto aprovado; aprovação exige prévia válida; revisão obsoleta impede aplicação silenciosa; rejeição/deferimento preservados | Integração de propostas e compatibilidade | L / autoridade canônica | D06 |
| D08 | Expor leitura delimitada e criação de proposta no MCP; handles vinculados a projeto, revisão e permissões | Paridade de autorização com CLI; cliente não escolhe outra raiz; sem aprovação MCP; handle revogado/obsoleto não recupera material | Contrato MCP e testes negativos | M / API dos agentes | D06, D07 |
| D09 | Workbench: catálogo de fontes, cobertura, comparação com original, conferência e revisão de sínteses | Usuário percorre mapa → bloco → original e entende lacunas; abertura de arquivos restrita às fontes autorizadas; ações usam revisão esperada | Integração HTTP, UI e acessibilidade manual | L / interface e superfície local | D05, D07 |
| D10 | Coaching mínimo por CLI: abrir questão, registrar sessão, escolher ação, registrar revisão e retomar; métodos opcionais do catálogo | Retomada distingue fatos, hipóteses, intenções e resultados; histórico preservado; registros não entram como perfil; aprendizado vai a D07 | Unitário e cenário de ponta a ponta | M / novo estado de trabalho | D07 |
| D11 | Integrar coaching ao MCP e Workbench e documentar protocolo para agentes; seleção delimitada de métodos | Mesmo cenário por interfaces disponíveis; agente registra candidatos, usuário confirma compromissos; nenhuma escrita canônica indireta; uso básico sem modelo | Paridade, UI e cenário completo | M / experiência de coaching | D08, D09, D10 |
| D12 | Fechar documentação, compatibilidade, pacote, runbook de recuperação e release | Verificação integral passa; pacote não contém acervo/derivados; exemplos executáveis; corpus e relatórios ligados aos critérios de aceite | Regressão, auditoria e instalação limpa | M / distribuição | D08, D09, D11 |

## Ordem e marcos

1. **M0 — Contrato viável:** D00 → D01. Resolver fidelidade, extração e armazenamento antes de construir interfaces.
2. **M1 — Fontes verificáveis:** D02 → D03 → D04 → D05. DOCX/Markdown exercitam primeiro o contrato de blocos; PDF adiciona ambiguidades de layout. Ao fim, há valor independente de coaching.
3. **M2 — Conhecimento revisável:** D06 → D07; depois D08 e D09 podem avançar independentemente. Recuperação precede síntese para testar o limite de autoridade antes da UX.
4. **M3 — Coaching utilizável:** D10 pode começar após D07; D11 reúne interfaces e ciclo. Evita esperar a interface para validar o modelo de coaching.
5. **M4 — Entrega do produto:** D12. Cada fatia exige seus próprios checks; o gate final reúne evidências, não substitui verificações anteriores.

Novos contratos são aditivos e opt-in. Nenhuma migração automática de diretórios existentes. Diretório chamado `coaching` não constitui permissão nem ativação.

## Colocação arquitetural

Paths novos são indicativos. Evitar concentrar todos os fluxos novos em `src/ecosystem.mjs`; extrair apenas o contrato compartilhado necessário, com testes de paridade.

| Módulo proposto ou existente | Camada e responsabilidade | Direção dos imports / fronteira |
|---|---|---|
| `src/evidence/model.mjs` | Domínio: fontes, revisões, blocos, estados e invariantes | Sem filesystem, parsers, CLI ou web |
| `src/evidence/service.mjs` | Casos de uso: registro, extração, conferência, retirada | Importa modelo; recebe portas de armazenamento, extração e autorização |
| `src/evidence/store.mjs` | Adaptador filesystem, revisões e publicação atômica | Depende dos contratos internos e primitivas seguras; não decide aprovação |
| `src/evidence/extractors/*.mjs` | Adaptadores Markdown/DOCX/PDF | Dependem do contrato de blocos; bibliotecas voláteis confinadas aqui |
| `src/evidence/retrieval.mjs` | Caso de uso de seleção e contexto de evidência | Recebe política e catálogo; integra `context-selection` sem enfraquecer regras |
| `src/coaching/model.mjs`, `service.mjs` | Domínio e casos de uso da capacidade | Coaching depende de contratos de evidência/proposta; evidência não importa coaching |
| `src/cli.mjs`, `src/mcp-server.mjs`, `src/web-server.mjs` | Adaptadores de entrada/composição existentes | Constroem adaptadores e chamam casos de uso; domínio não importa essas interfaces |
| `web/app.mjs` e componentes extraídos se necessário | Apresentação | Usa API estruturada; sem acesso arbitrário ao filesystem |
| `schemas/` | Contratos de armazenamento e interfaces | Versões explícitas; compatibilidade de propostas/contexto existentes |

### Persistência a decidir em D00

Usar área privada operacional própria, fora das raízes de conhecimento aprovado e fora da descoberta genérica de Markdown. Nome sugerido para discussão: `<self-root>/.holoself-evidence/`. Validar colisões e exclusões de indexação, backup e ferramentas antes de fixar o nome.

Registros duráveis de sessões, decisões de revisão e proveniência são legíveis e exportáveis; caches/extrações reconstruíveis são identificados separadamente. JSON pode servir a manifestos e índices operacionais, sem virar uma segunda autoridade oculta sobre o perfil. Decidir a representação legível de registros no ADR.

Referências externas à raiz exigem registro explícito pelo proprietário e política de localização. Clientes vinculados recebem handles, não liberdade para abrir caminhos. Não seguir symlinks, referências de rede ou relacionamentos externos de documentos durante extração.

## Requisitos não funcionais

| Área | Aplicação e alvo/decisão |
|---|---|
| Segurança | Conteúdo é dado não confiável, nunca instrução; bloquear traversal, symlinks indevidos, macros, fetch externo e abertura arbitrária. Testar ZIP bomb, tamanho real descompactado, timeout e conteúdo malformado |
| Privacidade | Zero bytes e zero metadados de fonte negada nas interfaces do cliente; índices/caches revogados junto da política. Derivados nunca ampliam permissões. Compartilhamento externo é ação separada |
| Retenção | Retirar da consulta, purgar derivados e excluir original são ações distintas. Retenção local até ação explícita no v1; retirada preserva original. Revisar referências de propostas e histórico antes de permitir purga; registrar indisponibilidade sem copiar conteúdo sensível para logs |
| Capacidade | Limites de H1; extração em worker/processo com timeout proposto de 60 s/arquivo e orçamento de 512 MiB por job, mecanismo validado em D01. Só um job pesado simultâneo por processo no v1 |
| Desempenho | Meta inicial: consulta de mapa aquecida p95 <=1 s em corpus de 1.000 fontes/50.000 blocos, excluída extração. D01/D06 registram hardware e resultado; ajuste exige decisão explícita, não resultado inventado |
| Confiabilidade | Interrupção deixa staging recuperável, nunca registro completo inválido; revisão esperada recusa concorrência; retries explícitos não duplicam revisão; fonte muda durante extração → resultado descartado/desatualizado |
| Observabilidade | Recibo com IDs, revisões, extrator, cobertura, duração e códigos de erro; logs sem corpos ou caminhos privados por padrão |
| Operação | Feature opt-in; exportar registros duráveis antes de downgrade; limpeza de staging restrita à área gerenciada; doctor indica dependências ausentes e estados incompletos |
| Compatibilidade | Consultas e propostas anteriores continuam válidas; novos campos aditivos ou versão nova com leitor compatível. Nenhuma alteração silenciosa na semântica de `reference/` ou `topics/` |
| Custo | Nenhuma chamada paga ou instalação automática no fluxo básico; OCR/modelos opcionais exigiriam contrato posterior e indicação de custo |
| Usabilidade/acessibilidade | Estados claros, erros acionáveis, teclado e rótulos acessíveis; cobertura não apresentada como selo de verdade. Confirmar paridade das ações essenciais CLI/UI |
| Manutenção | Regras testáveis sem parser/web; dependências justificadas e verificadas; fixtures têm gabarito humano e não contêm dados reais |
| Portabilidade | Testar Node mínimo e versão de referência em Windows/Linux/macOS; recursos nativos opcionais devem degradar explicitamente. CI indisponível para plataforma fica registrado como lacuna |

## Gates, decisões e rollback

### ADRs em D00/D01

1. Propriedade, localização e ciclo de vida de fontes, registros duráveis e derivados; referência versus snapshot do original.
2. Identidade/revisão, localização de blocos e semântica de cobertura/fidelidade.
3. Autorização e recuperação explícita de evidência, incluindo restrição de metadados e revogação.
4. Extratores, limites, isolamento, licenças e recursos opcionais.
5. Extensão da proveniência e revalidação de propostas sem alteração da autoridade humana.
6. Estado mínimo de coaching e separação entre registro de sessão, compromisso confirmado e aprendizado aprovado.

### Gates por fatia

- Executar os testes relevantes e mostrar resultado, versão e limitações. Testes novos de privacidade/path safety são obrigatórios quando a superfície muda.
- Fazer `git diff --check`; documentação e exemplos acompanham a interface na mesma entrega.
- Em D00, revisão de contrato e cobertura do corpus. Em D01, decisão apoiada em medições. Em D06/D08, revisão adversarial de autorização. Em D07, revisão de autoridade/replay/concorrência. Em D12, gate integral e pacote.
- Revisões adicionais por outro agente/provedor são opcionais e precisam de escopo explícito; este plano não agenda coordenação automática.
- Aprovação de conhecimento não certifica uma avaliação como verdadeira. A prévia apresenta autoria, período, incerteza e texto exato a adotar.

### Rollback

- Até D06, desativar capacidade e excluir somente derivados gerenciados após prévia; preservar originais e registros duráveis/conferências.
- D07: alterações já aprovadas são revertidas pelo fluxo de revisão/histórico, nunca apagando recibos. Fonte retirada sinaliza dependências afetadas; não apaga silenciosamente conhecimento aprovado.
- D08–D11: retirar novas rotas/tools e desligar interface preserva dados legíveis. Exportar registros antes de downgrade que não compreenda o novo esquema.
- Não há exclusão ou migração irreversível planejada. Se uma se tornar necessária, requer plano de backup, restauração verificada e decisão separada antes de execução.

## Condições para execução autônoma das fatias

Comandos de testes abaixo são entregas propostas; os arquivos ainda não existem. Cada execução deve mostrar a saída do check, resumir mudanças e respeitar as hipóteses H1–H8 (itens 1–8). Limites são pontos de revisão, não autorização para declarar sucesso parcial. Não iniciar goals nem execução com este documento.

| ID | Estado final e prova a apresentar | Restrições / interrupção | Limite de revisão |
|---|---|---|---|
| D00 | ADRs e matriz requisito→fixture completos; `node --test tests/docs.test.mjs tests/evidence-contract.test.mjs` passa | Sem dados reais; interromper se propriedade/autorização exigir mudar princípio canônico | 6 turnos |
| D01 | Relatório comparativo reproduzido por `node scripts/evidence-spike.mjs --fixtures` com decisão e limitações | Sem prometer fidelidade não demonstrada; interromper se H1/H2/H6 inviáveis | 8 turnos |
| D02 | Registro, revisão e retirada comprovados por `node --test tests/evidence-sources.test.mjs` | Originais intactos; interromper se H5 não puder ser garantida | 10 turnos |
| D03 | Relações e cobertura corretas em `node --test tests/evidence-docx-markdown.test.mjs`, mais inspeção selecionada registrada | Sem fetch/macros; parar se extrator contradizer D01 ou H2 | 12 turnos |
| D04 | PDF contabilizado e falhas explícitas em `node --test tests/evidence-pdf.test.mjs`, com evidência visual do corpus | Sem OCR implícito; parar se limites H1/H3/H6 não forem aplicáveis | 12 turnos |
| D05 | Conferência, correção e invalidação passam em `node --test tests/evidence-fidelity.test.mjs` | Preservar recibos duráveis e original; parar em conflito não resolvido de revisão | 10 turnos |
| D06 | Recuperação explícita sem vazamento em `node --test tests/evidence-retrieval.test.mjs tests/privacy-capabilities.test.mjs tests/efficiency.test.mjs`; benchmark documentado | Sem habilitar corpus por padrão; parar se H4 ou orçamento vigente forem incompatíveis | 12 turnos |
| D07 | Aprovação/rejeição/replay passam em `node --test tests/evidence-proposals.test.mjs tests/ecosystem.test.mjs` | Sem escrita antes de aprovação nem alteração de propostas históricas; parar se exigir novo mecanismo de autoridade | 12 turnos |
| D08 | CLI/MCP com decisões equivalentes em `node --test tests/evidence-mcp.test.mjs tests/mcp.test.mjs` | Sem roots arbitrários ou aprovação MCP; parar se política não puder ser aplicada antes de leitura | 10 turnos |
| D09 | Percurso de revisão funciona em `node --test tests/evidence-web.test.mjs tests/web-ui.test.mjs`, com verificação de teclado e estados | Sem renderização ativa de documento não confiável; parar se prévia exigir envio remoto | 12 turnos |
| D10 | Questão→sessão→ação→revisão→retomada passa em `node --test tests/coaching.test.mjs` | Sem programas extensos ou perfil implícito; parar se escopo ultrapassar H7 | 10 turnos |
| D11 | Cenário equivalente nas interfaces em `node --test tests/coaching-surfaces.test.mjs`, com walkthrough registrado | Sem compromissos inferidos ou modelo obrigatório; parar se H4/H7 falharem | 10 turnos |
| D12 | `node scripts/verify.mjs`, `git diff --check` e instalação limpa passam; matriz final aponta evidências | Não publicar automaticamente; plataformas sem teste permanecem lacunas declaradas | 10 turnos |

## Condições de revisão do plano

Retornar à decisão de produto se: fidelidade exigir serviço remoto obrigatório; limites tornarem os casos de uso inviáveis; permissões atuais não representarem o isolamento necessário; persistência implicar segunda autoridade sobre o perfil; compatibilidade exigir migração destrutiva; ou suporte de formatos depender de licença/distribuição inadequada.

Problemas técnicos locais e reversíveis devem ser resolvidos dentro da fatia, registrando a decisão. Não interromper por escolhas de implementação cobertas pelos contratos.

## Próximo passo e aprovação

Revisar este breakdown e autorizar D00–D01 como primeiro lote. A decisão após o spike confirma contratos e dependências antes de D02. O pedido atual cobre planejamento; nenhum desenvolvimento, migração privada ou publicação foi iniciado.
