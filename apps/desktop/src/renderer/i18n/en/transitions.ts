import type { ruTransitions } from '../ru/transitions';
import type { DictShape } from '../types';

/** English UI strings — plan transitions (ADR-0086). */
export const enTransitions: DictShape<typeof ruTransitions> = {
  'billing.switchPlan': 'Switch plan',
  'billing.transition.blockedTitle': 'You can’t switch to {plan} yet',
  'billing.transition.blockedHint': 'Fix this first — we never delete or turn anything off for you.',
  'billing.transition.why': 'Why not',
  'billing.transition.notFit': 'Over this plan’s limits',
  'billing.violation.members': {
    one: 'The workspace has {n} member, but {plan} allows at most {limit}. Remove the extra ones to switch.',
    other: 'The workspace has {n} members, but {plan} allows at most {limit}. Remove the extra ones to switch.',
  },
  'billing.violation.bots': {
    one: 'You have {n} bot, but {plan} allows at most {limit}. Remove the extra ones to switch.',
    other: 'You have {n} bots, but {plan} allows at most {limit}. Remove the extra ones to switch.',
  },
  'billing.violation.boards': {
    one: 'You have {n} board (archived included), but {plan} allows at most {limit}. Delete the extra ones to switch.',
    other: 'You have {n} boards (archived included), but {plan} allows at most {limit}. Delete the extra ones to switch.',
  },
  'billing.violation.stickerPacks': {
    one: 'You have {n} sticker pack, but {plan} allows at most {limit}. Delete the extra ones to switch.',
    other: 'You have {n} sticker packs, but {plan} allows at most {limit}. Delete the extra ones to switch.',
  },
  'billing.violation.stickers': {
    one: 'Your sticker packs have {n} sticker, but {plan} allows at most {limit}. Delete the extra ones to switch.',
    other: 'Your sticker packs have {n} stickers, but {plan} allows at most {limit}. Delete the extra ones to switch.',
  },
  'billing.violation.oauth': {
    one: '{n} OAuth app is connected, but {plan} doesn’t include them. Disable it to switch.',
    other: '{n} OAuth apps are connected, but {plan} doesn’t include them. Disable them to switch.',
  },
  'billing.violation.webhooks': {
    one: '{n} board webhook is on, but {plan} doesn’t include them. Turn it off to switch.',
    other: '{n} board webhooks are on, but {plan} doesn’t include them. Turn them off to switch.',
  },
  'billing.violation.automations': {
    one: '{n} automation rule is on, but {plan} doesn’t include automations. Turn it off to switch.',
    other: '{n} automation rules are on, but {plan} doesn’t include automations. Turn them off to switch.',
  },
  'billing.violation.roomMembers': {
    one: '{n} voice room allows up to {current} people, but {plan} allows at most {limit}. Lower the limit in the room settings.',
    other: '{n} voice rooms allow up to {current} people, but {plan} allows at most {limit}. Lower the limit in the room settings.',
  },
  'billing.violation.forms': {
    one: 'A board has {n} form, but {plan} allows at most {limit} per board. Delete the extra ones to switch.',
    other: 'A board has {n} forms, but {plan} allows at most {limit} per board. Delete the extra ones to switch.',
  },
  'billing.violation.formsOff': 'Your boards have forms, but {plan} doesn’t include them. Delete the forms to switch.',
  'billing.violation.storage': 'Files take {used}, but {plan} has {limit}. Delete files you don’t need to switch.',
  'billing.violation.sso': 'SSO sign-in is on, but {plan} doesn’t include it. Turn SSO off to switch.',
  'billing.violation.directory': 'Directory sync (LDAP) is on, but {plan} doesn’t include it. Turn it off to switch.',
  'billing.violation.telephony': 'Telephony (SIP) is on, but {plan} doesn’t include it. Turn telephony off to switch.',
  'billing.violation.other': 'The workspace uses more than {plan} allows.',
  'billing.fix.members': 'Go to members',
  'billing.fix.bots': 'Go to bots',
  'billing.fix.stickers': 'Go to stickers',
  'billing.fix.identity': 'Go to SSO settings',
  'billing.fix.oauth': 'Go to OAuth apps',
  'billing.fix.telephony': 'Go to telephony',
  'billing.fix.boards': 'Go to boards',
  'billing.fix.open': 'Open',
  'billing.adminAssigned.title': 'Plan assigned by an administrator',
  'billing.adminAssigned.text': 'Your plan was assigned by an administrator. Contact support to change it.',
  'billing.adminAssigned.contact': 'Contact support',
  'billing.pay.seatsPlan': 'How many people to plan the top-up for',
  'billing.pay.topupLine': 'Balance top-up',
  'billing.pay.topupHint': {
    one: 'Lasts about 30 days for {n} person',
    other: 'Lasts about 30 days for {n} people',
  },
  'billing.pay.todayLine': 'Charged today',
  'billing.pay.todayHint': {
    one: 'For {n} member — that’s your team now. After that, every 24 hours for the actual number of members.',
    other: 'For {n} members — that’s your team now. After that, every 24 hours for the actual number of members.',
  },
  'billing.pay.noTopup': 'No top-up needed — the balance covers it',
  'billing.quote.netChange': 'We return {back} for the unused time of {from} and charge {charge} for a day of {to} — {total} in total.',
  'billing.history.op.change': 'Plan change {from} → {to}',
  'billing.history.op.activate': '{plan} started',
  'billing.history.op.resume': '{plan} resumed',
  'billing.history.op.details': 'Details',
  'billing.history.op.hide': 'Hide',
  'admin.plan.overTitle': 'The workspace doesn’t fit this plan',
  'admin.plan.overText': 'You can assign it anyway: the excess goes to the plan log and the limits will block new additions.',
  'admin.plan.overConfirm': 'Assign anyway',
};
