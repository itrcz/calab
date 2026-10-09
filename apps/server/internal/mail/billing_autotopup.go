package mail

// Auto-topup outcome mails (ADR-0080 §7, T7) to the workspace owner, financial like the other
// billing mails (billing.go): a real decline, and a bank that asked for authentication (the
// off-session payment was canceled). The button opens the app (the billing cabinet) to top up
// by hand; the next automatic attempt is not earlier than 24 h.
const (
	TemplateBillingAutoTopupFailed         Template = "billing_autotopup_failed"          // amount, code
	TemplateBillingAutoTopupActionRequired Template = "billing_autotopup_action_required" // amount
)

type autoTopupLabels struct {
	Amount, Code, Open string
	Failed, Action     [3]string // subject, title, line
	Note               string
}

var autoTopupDict = map[string]autoTopupLabels{
	LocaleEN: {
		Amount: "Amount", Code: "Bank answer", Open: "Top up manually",
		Failed: [3]string{"Auto top-up failed — “{{.workspace}}”", "The automatic top-up was declined",
			"The bank declined the automatic top-up of “{{.workspace}}”. Top up the balance by hand; the next automatic attempt is not earlier than in 24 hours."},
		Action: [3]string{"Auto top-up needs you — “{{.workspace}}”", "The bank asked for confirmation",
			"The bank wants you to confirm the payment, which an automatic top-up cannot do, so it was canceled. Top up the balance of “{{.workspace}}” by hand; the next automatic attempt is not earlier than in 24 hours."},
		Note: "You get this mail because auto top-up is on. Only the owner of the workspace gets billing mail.",
	},
	LocaleRU: {
		Amount: "Сумма", Code: "Ответ банка", Open: "Пополнить вручную",
		Failed: [3]string{"Автопополнение не прошло — «{{.workspace}}»", "Банк отклонил автопополнение",
			"Банк отклонил автоматическое пополнение «{{.workspace}}». Пополните баланс вручную; следующая автоматическая попытка — не раньше чем через 24 часа."},
		Action: [3]string{"Автопополнению нужно ваше подтверждение — «{{.workspace}}»", "Банк запросил подтверждение",
			"Банк просит подтвердить платёж, а автопополнение этого не может, поэтому платёж отменён. Пополните баланс «{{.workspace}}» вручную; следующая автоматическая попытка — не раньше чем через 24 часа."},
		Note: "Письмо пришло, потому что включено автопополнение. Письма об оплате получает только владелец пространства.",
	},
	LocaleES: {
		Amount: "Importe", Code: "Respuesta del banco", Open: "Recargar a mano",
		Failed: [3]string{"La recarga automática falló — «{{.workspace}}»", "El banco rechazó la recarga automática",
			"El banco rechazó la recarga automática de «{{.workspace}}». Recarga el saldo a mano; el siguiente intento automático no será antes de 24 horas."},
		Action: [3]string{"La recarga automática te necesita — «{{.workspace}}»", "El banco pidió una confirmación",
			"El banco quiere que confirmes el pago y una recarga automática no puede hacerlo, así que se canceló. Recarga el saldo de «{{.workspace}}» a mano; el siguiente intento automático no será antes de 24 horas."},
		Note: "Recibes este correo porque la recarga automática está activada. Solo el propietario del espacio recibe correos de facturación.",
	},
	LocaleZhCN: {
		Amount: "金额", Code: "银行回复", Open: "手动充值",
		Failed: [3]string{"自动充值失败 — “{{.workspace}}”", "银行拒绝了自动充值",
			"银行拒绝了“{{.workspace}}”的自动充值。请手动充值；下一次自动尝试不早于 24 小时后。"},
		Action: [3]string{"自动充值需要您确认 — “{{.workspace}}”", "银行要求确认",
			"银行要求您确认付款，自动充值无法完成确认，因此已取消。请手动为“{{.workspace}}”充值；下一次自动尝试不早于 24 小时后。"},
		Note: "您收到此邮件是因为已开启自动充值。只有工作区所有者会收到账单邮件。",
	},
}

func autoTopupTexts(l autoTopupLabels) map[Template]texts {
	t := func(s [3]string, d []detail) texts {
		return texts{Subject: s[0], Title: s[1], Line: s[2], Button: l.Open, Note: l.Note, Details: d}
	}
	return map[Template]texts{
		TemplateBillingAutoTopupFailed:         t(l.Failed, []detail{{l.Amount, "amount"}, {l.Code, "code"}}),
		TemplateBillingAutoTopupActionRequired: t(l.Action, []detail{{l.Amount, "amount"}}),
	}
}

func init() {
	for loc, l := range autoTopupDict {
		for t, tx := range autoTopupTexts(l) {
			dict[loc][t] = tx
			templates[t] = []string{"workspace", "url"}
		}
	}
}

func isAutoTopupTemplate(t Template) bool {
	return t == TemplateBillingAutoTopupFailed || t == TemplateBillingAutoTopupActionRequired
}
