#!/usr/bin/env bash
set -euo pipefail

# Despacha uma tarefa orquestrada pra um dos panes de agente do workspace
# cmux atual. Sempre prefixa o prompt com [ORCH:<task-id>] — esse é o gatilho
# que faz os 4 CLAUDE.md de subprojeto lerem .orchestration/INSTRUCTIONS.md
# e aplicarem as regras de modo orquestrado (cwd-only, sem commit, etc).
#
# Uso:
#   scripts/cmux-dispatch.sh [--wait [--timeout <s>]] <Pane> <task-id> <prompt>
#
# Exemplos:
#   scripts/cmux-dispatch.sh Extension 03-ts-codec "Implemente passo 3 do plan/03-protocol.md"
#   scripts/cmux-dispatch.sh --wait Extension 03-ts-codec "Implemente..."
#
# Argumentos:
#   --wait              (opcional) bloqueia até o agente gravar
#                       .orchestration/results/<task-id>.md. Polling de
#                       mtime no arquivo (snapshot antes do dispatch, espera
#                       mudança após). Independente de hooks — funciona com
#                       claude puro (sem cmux claude-teams). Convenção do
#                       result file está nos CLAUDE.md de cada subprojeto.
#   --timeout <s>       (opcional, default 1800) timeout em segundos pro --wait
#   --poll-interval <s> (opcional, default 2) intervalo entre checagens
#   <Pane>              App | Relay | Extension | Site
#   <task-id>           ID curto (kebab/snake: a-z 0-9 . _ -)
#   <prompt>            texto do prompt (use aspas se tem espaços)
#
# Pra conversa fora do protocolo orquestrado (perguntas exploratórias,
# debug, retomar claude), use `cmux send` direto. Esse script é
# exclusivamente pro modo orquestrado — ele EXISTE pra não esquecer o
# marker.

usage() {
  awk '
    /^# Despacha/ { on = 1 }
    on {
      if (!/^#/) exit
      sub(/^# /, "")
      sub(/^#$/, "")
      print
    }
  ' "$0"
}

wait_flag=0
wait_timeout=1800
poll_interval=2

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)        usage; exit 0 ;;
    --wait)           wait_flag=1; shift ;;
    --timeout)        wait_timeout="${2:-}"; shift 2 || { echo "erro: --timeout precisa de valor" >&2; exit 2; } ;;
    --poll-interval)  poll_interval="${2:-}"; shift 2 || { echo "erro: --poll-interval precisa de valor" >&2; exit 2; } ;;
    --)               shift; break ;;
    -*)               echo "erro: flag desconhecida: $1" >&2; usage >&2; exit 2 ;;
    *)                break ;;
  esac
done

if [ $# -lt 3 ]; then
  usage >&2
  echo >&2
  echo "erro: argumentos insuficientes (esperado 3 posicionais, recebido $#)" >&2
  exit 2
fi

pane="$1"
task_id="$2"
shift 2
prompt="$*"

valid_panes=(App Relay Extension Site)
case " ${valid_panes[*]} " in
  *" $pane "*) ;;
  *)
    echo "erro: pane '$pane' inválido. Use: ${valid_panes[*]}" >&2
    exit 2
    ;;
esac

if [[ ! "$task_id" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "erro: task-id '$task_id' inválido (use a-z A-Z 0-9 . _ -)" >&2
  exit 2
fi

if [ -z "$prompt" ]; then
  echo "erro: prompt vazio" >&2
  exit 2
fi

command -v cmux >/dev/null || { echo "erro: cmux não encontrado no PATH" >&2; exit 1; }

WS_REF=$(cmux identify 2>/dev/null \
  | awk -F'"' '/"workspace_ref"/ {print $4; exit}')
[ -n "$WS_REF" ] || { echo "erro: workspace cmux não identificado" >&2; exit 1; }

# resolve surface ID pelo título do pane no workspace alvo
sid=$(cmux tree 2>/dev/null | awk -v target="$WS_REF" -v name="$pane" '
  /workspace workspace:/ {
    in_ws = 0
    for (i = 1; i <= NF; i++) if ($i == target) in_ws = 1
    next
  }
  in_ws && /surface surface:/ && index($0, "\"" name "\"") {
    for (i = 1; i <= NF; i++) if ($i ~ /^surface:/) { print $i; exit }
  }
')

if [ -z "$sid" ]; then
  echo "erro: pane '$pane' não encontrado no workspace $WS_REF" >&2
  echo "rode scripts/cmux-bootstrap-agents.sh pra criar os 4 panes" >&2
  exit 3
fi

full_prompt="[ORCH:${task_id}] ${prompt}"

# Pra --wait: capturar mtime do result file ANTES do dispatch. Polling
# depois detecta mudança vs estado anterior, então re-dispatches do mesmo
# task-id (sobrescrita) também são corretamente esperados. Stat retorna 0
# quando arquivo não existe — qualquer mtime real será > 0.
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
result_file="$REPO_ROOT/.orchestration/results/${task_id}.md"
before_mtime=$(stat -f %m "$result_file" 2>/dev/null || stat -c %Y "$result_file" 2>/dev/null || echo 0)

cmux send     --surface "$sid" -- "$full_prompt" >/dev/null

# Pequena pausa pro TUI do claude no destino terminar de processar o paste
# antes do Enter chegar — sem isso, prompts grandes (>2KB) racing com o
# bracketed-paste mode fazem o Enter virar newline no buffer em vez de
# submit. Sintoma: prompt fica grudado na caixa de texto, "pula linha".
sleep 0.4

cmux send-key --surface "$sid" enter >/dev/null

printf "ok  %-10s %s\n     [ORCH:%s] %s\n" "$pane" "$sid" "$task_id" "$prompt"

if [ "$wait_flag" -eq 1 ]; then
  # Polling do result file que o agente em modo orquestrado é convencionado
  # a gravar (ver INSTRUCTIONS.md). Detecta conclusão por mudança de mtime
  # vs snapshot pré-dispatch — funciona pra arquivo novo (0 → ts) e
  # pra re-dispatch (ts_old → ts_novo).
  #
  # Compatível com claude puro (sem cmux claude-teams). Não depende de
  # hook nenhum — só do contrato de "agente termina escrevendo o result".
  echo "aguardando $result_file (poll ${poll_interval}s, timeout ${wait_timeout}s)..." >&2

  start_ts=$(date +%s)
  while :; do
    cur_mtime=$(stat -f %m "$result_file" 2>/dev/null || stat -c %Y "$result_file" 2>/dev/null || echo 0)
    if [ "$cur_mtime" -gt "$before_mtime" ]; then
      # arquivo existe e mudou desde o dispatch. Confirma que tem conteúdo
      # estruturado (linha Status: ...) — protege contra agente que cria
      # o arquivo vazio antes de escrever (caso raro mas observado).
      if grep -qE '^\*?\*?Status\*?\*?:' "$result_file" 2>/dev/null; then
        elapsed=$(( $(date +%s) - start_ts ))
        echo "ok  $pane completou em ${elapsed}s ($result_file)" >&2
        exit 0
      fi
    fi
    elapsed=$(( $(date +%s) - start_ts ))
    if [ "$elapsed" -ge "$wait_timeout" ]; then
      echo "timeout (${wait_timeout}s) sem result file de $pane" >&2
      exit 4
    fi
    sleep "$poll_interval"
  done
fi
