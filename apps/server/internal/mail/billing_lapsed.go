package mail

import (
	"fmt"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// «Тариф не активен» mails (ADR-0086 amendment 1) to the workspace owner and the BILLING_MANAGE
// holders (ADR-0087): the workspace entered the restricted mode, and the heads-up a day before
// the last paid day ends when the usage does not fit Free. No prices (the cabinet shows the
// plans). Financial like the other billing mails (billing.go).
const (
	TemplateBillingLapsed    Template = "billing_lapsed"     // reasons (what does not fit Free)
	TemplateBillingLapseSoon Template = "billing_lapse_soon" // deadline, reasons
)

type lapsedLabels struct {
	Deadline, Reasons, Open string
	Lapsed, Soon            [3]string // subject, title, line
	Note                    string
}

var lapsedDict = map[string]lapsedLabels{
	LocaleEN: {
		Deadline: "Paid days end", Reasons: "Does not fit Free", Open: "Open billing",
		Lapsed: [3]string{"Plan not active — “{{.workspace}}”", "The plan is not active",
			"The paid days of “{{.workspace}}” are over and the workspace does not fit Free, so it works in a restricted mode: everything can be read, but writing in chats, uploads, invitations and new rooms, boards and bots are paused, and voice rooms take two people, audio only. Pay for a plan, or bring the workspace within the Free limits and switch to Free."},
		Soon: [3]string{"Tomorrow the plan stops — “{{.workspace}}”", "Tomorrow the plan stops being active",
			"The paid days of “{{.workspace}}” end soon, and the workspace does not fit Free. After that it works in a restricted mode: writing in chats, uploads, invitations and new rooms are paused, voice rooms take two people, audio only. Renew a plan, or bring the workspace within the Free limits before then."},
		Note: "Sent to the owner of the workspace and the members who manage billing.",
	},
	LocaleRU: {
		Deadline: "Оплаченные дни кончаются", Reasons: "Что не помещается во Free", Open: "Открыть оплату",
		Lapsed: [3]string{"Тариф не активен — «{{.workspace}}»", "Тариф не активен",
			"Оплаченные дни пространства «{{.workspace}}» закончились, а оно не помещается во Free, поэтому работает в ограниченном режиме: читать можно всё, но писать в чаты, загружать файлы, приглашать людей и создавать комнаты, доски и ботов нельзя, а в голосовой комнате — двое, только звук. Оплатите тариф или приведите пространство к лимитам Free и перейдите на Free."},
		Soon: [3]string{"Завтра тариф перестанет быть активным — «{{.workspace}}»", "Завтра тариф перестанет быть активным",
			"Оплаченные дни пространства «{{.workspace}}» скоро закончатся, а оно не помещается во Free. После этого оно будет работать в ограниченном режиме: писать в чаты, загружать файлы, приглашать людей и создавать комнаты нельзя, в голосовой комнате — двое, только звук. Продлите тариф или приведите пространство к лимитам Free заранее."},
		Note: "Письмо получают владелец пространства и участники с правом управлять оплатой.",
	},
	LocaleES: {
		Deadline: "Los días pagados terminan", Reasons: "No cabe en Free", Open: "Abrir facturación",
		Lapsed: [3]string{"Plan inactivo — «{{.workspace}}»", "El plan no está activo",
			"Los días pagados de «{{.workspace}}» terminaron y el espacio no cabe en Free, así que funciona en modo restringido: se puede leer todo, pero escribir en los chats, subir archivos, invitar y crear salas, tableros y bots está en pausa, y las salas de voz admiten dos personas, solo audio. Paga un plan o ajusta el espacio a los límites de Free y pasa a Free."},
		Soon: [3]string{"Mañana el plan deja de estar activo — «{{.workspace}}»", "Mañana el plan deja de estar activo",
			"Los días pagados de «{{.workspace}}» terminan pronto y el espacio no cabe en Free. Después funcionará en modo restringido: escribir en los chats, subir archivos, invitar y crear salas estará en pausa, y las salas de voz admitirán dos personas, solo audio. Renueva un plan o ajusta el espacio a los límites de Free antes."},
		Note: "Se envía al propietario del espacio y a los miembros que gestionan la facturación.",
	},
	LocaleZhCN: {
		Deadline: "付费天数结束", Reasons: "超出 Free 的部分", Open: "打开账单",
		Lapsed: [3]string{"套餐未生效 — “{{.workspace}}”", "套餐未生效",
			"“{{.workspace}}”的付费天数已结束，且工作区超出 Free 限制，因此进入受限模式：仍可阅读全部内容，但聊天发言、上传文件、邀请成员以及新建房间、看板和机器人均被暂停，语音房间限两人且仅音频。请付费订阅套餐，或将工作区调整到 Free 限制内并切换到 Free。"},
		Soon: [3]string{"明天套餐将失效 — “{{.workspace}}”", "明天套餐将不再生效",
			"“{{.workspace}}”的付费天数即将结束，且工作区超出 Free 限制。之后将进入受限模式：聊天发言、上传文件、邀请成员和新建房间均被暂停，语音房间限两人且仅音频。请在此之前续订套餐，或将工作区调整到 Free 限制内。"},
		Note: "此邮件发送给工作区所有者和有权管理账单的成员。",
	},
}

func lapsedTexts(l lapsedLabels) map[Template]texts {
	reasons := detail{l.Reasons, "reasons"}
	return map[Template]texts{
		TemplateBillingLapsed:    {Subject: l.Lapsed[0], Title: l.Lapsed[1], Line: l.Lapsed[2], Button: l.Open, Note: l.Note, Details: []detail{reasons}},
		TemplateBillingLapseSoon: {Subject: l.Soon[0], Title: l.Soon[1], Line: l.Soon[2], Button: l.Open, Note: l.Note, Details: []detail{{l.Deadline, "deadline"}, reasons}},
	}
}

func init() {
	for loc, l := range lapsedDict {
		for t, tx := range lapsedTexts(l) {
			dict[loc][t] = tx
			templates[t] = []string{"workspace", "url"}
		}
	}
}

func isLapsedTemplate(t Template) bool {
	return t == TemplateBillingLapsed || t == TemplateBillingLapseSoon
}

// blockerNames: how a limit kind reads in a mail, per locale. A name with a "!" prefix is a
// feature in use that Free lacks (shown without numbers).
var blockerNames = map[string]map[v1.PlanLimitKind]string{
	LocaleEN: {
		v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS: "members", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS: "bots",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB: "storage, MB", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARDS: "boards",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKER_PACKS: "sticker packs", v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKERS: "stickers",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_ROOM_MEMBERS: "voice room size", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_FORMS: "board forms",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_SSO: "!single sign-on", v1.PlanLimitKind_PLAN_LIMIT_KIND_DIRECTORY_SYNC: "!directory sync",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_OAUTH_APPS: "!OAuth apps", v1.PlanLimitKind_PLAN_LIMIT_KIND_TELEPHONY: "!telephony",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_WEBHOOKS: "!board webhooks", v1.PlanLimitKind_PLAN_LIMIT_KIND_AUTOMATIONS: "!board automations",
	},
	LocaleRU: {
		v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS: "участники", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS: "боты",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB: "хранилище, МБ", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARDS: "доски",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKER_PACKS: "наборы стикеров", v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKERS: "стикеры",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_ROOM_MEMBERS: "размер голосовой комнаты", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_FORMS: "формы досок",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_SSO: "!единый вход (SSO)", v1.PlanLimitKind_PLAN_LIMIT_KIND_DIRECTORY_SYNC: "!синхронизация каталога",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_OAUTH_APPS: "!OAuth-приложения", v1.PlanLimitKind_PLAN_LIMIT_KIND_TELEPHONY: "!телефония",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_WEBHOOKS: "!вебхуки досок", v1.PlanLimitKind_PLAN_LIMIT_KIND_AUTOMATIONS: "!автоматизации досок",
	},
	LocaleES: {
		v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS: "miembros", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS: "bots",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB: "almacenamiento, MB", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARDS: "tableros",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKER_PACKS: "paquetes de stickers", v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKERS: "stickers",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_ROOM_MEMBERS: "tamaño de sala de voz", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_FORMS: "formularios de tableros",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_SSO: "!inicio de sesión único", v1.PlanLimitKind_PLAN_LIMIT_KIND_DIRECTORY_SYNC: "!sincronización de directorio",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_OAUTH_APPS: "!aplicaciones OAuth", v1.PlanLimitKind_PLAN_LIMIT_KIND_TELEPHONY: "!telefonía",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_WEBHOOKS: "!webhooks de tableros", v1.PlanLimitKind_PLAN_LIMIT_KIND_AUTOMATIONS: "!automatizaciones de tableros",
	},
	LocaleZhCN: {
		v1.PlanLimitKind_PLAN_LIMIT_KIND_MEMBERS: "成员", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOTS: "机器人",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STORAGE_MB: "存储（MB）", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARDS: "看板",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKER_PACKS: "贴纸包", v1.PlanLimitKind_PLAN_LIMIT_KIND_STICKERS: "贴纸",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_ROOM_MEMBERS: "语音房间人数", v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_FORMS: "看板表单",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_SSO: "!单点登录", v1.PlanLimitKind_PLAN_LIMIT_KIND_DIRECTORY_SYNC: "!目录同步",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_OAUTH_APPS: "!OAuth 应用", v1.PlanLimitKind_PLAN_LIMIT_KIND_TELEPHONY: "!电话",
		v1.PlanLimitKind_PLAN_LIMIT_KIND_BOARD_WEBHOOKS: "!看板 Webhook", v1.PlanLimitKind_PLAN_LIMIT_KIND_AUTOMATIONS: "!看板自动化",
	},
}

// maxBlockers bounds the list in a mail (the cabinet shows the whole list).
const maxBlockers = 6

// FreeBlockers words what keeps a workspace from fitting Free for a recipient of locale: «members
// 12 / 10; storage, MB 800 / 500; telephony». "" when nothing blocks.
func FreeBlockers(locale string, vs []*v1.PlanLimitViolation) string {
	names := blockerNames[Locale(locale)]
	var out []string
	for _, v := range vs {
		name := names[v.GetKind()]
		switch {
		case name == "":
			continue
		case strings.HasPrefix(name, "!"):
			out = append(out, name[1:])
		case v.GetLimit() == 0:
			out = append(out, name) // a feature Free lacks, counted (board forms)
		default:
			out = append(out, fmt.Sprintf("%s %d / %d", name, v.GetCurrent(), v.GetLimit()))
		}
		if len(out) == maxBlockers {
			break
		}
	}
	return strings.Join(out, "; ")
}
