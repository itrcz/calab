import { ScreenSharePreset } from '@calaba/protocol';
import { type ReactNode } from 'react';
import { Input, Row, Select, Toggle } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { audioTierLabel } from '../../lib/audioTierLabel';
import { AUDIO_CAP_OPTIONS, type LimitsField, type LimitsForm } from '../../lib/plan';

/**
 * The limits of a custom plan as a superadmin edits them (ADR-0024): the manual plan form of a
 * workspace and the custom plan of a billing account (ADR-0086 «Индивидуальный тариф») share it.
 * Rows only — the caller puts them in a card or a dialog. 0 / empty = no limit.
 */

const STREAM_PRESETS = [ScreenSharePreset.UNSPECIFIED, ScreenSharePreset.ECONOMY, ScreenSharePreset.H720, ScreenSharePreset.H1080, ScreenSharePreset.ORIGINAL];
const CAMERA_PRESET_OPTIONS = [ScreenSharePreset.UNSPECIFIED, ScreenSharePreset.H720, ScreenSharePreset.H1080];
const PRESET_NAME: Record<ScreenSharePreset, MessageKey> = {
  [ScreenSharePreset.UNSPECIFIED]: 'plan.unlimited',
  [ScreenSharePreset.ECONOMY]: 'preset.economy',
  [ScreenSharePreset.H720]: 'preset.h720',
  [ScreenSharePreset.H1080]: 'preset.h1080',
  [ScreenSharePreset.ORIGINAL]: 'preset.original',
};

/** The label of a numeric field (also names the invalid one in an error). */
export const FIELD_LABEL: Record<LimitsField, MessageKey> = {
  boardFormsPerBoard: 'forms.limit',
  roomMembers: 'plan.limit.roomMembers',
  members: 'plan.limit.members',
  streamsPerRoom: 'plan.limit.streams',
  streamMaxFps: 'admin.limit.streamFps',
  cameraMaxFps: 'admin.limit.cameraFps',
  storageMb: 'admin.limit.storageMb',
  bots: 'plan.limit.bots',
  stickerPacks: 'plan.limit.stickerPacks',
};

function NumberField({ field, form, onChange }: { field: LimitsField; form: LimitsForm; onChange: (f: LimitsForm) => void }): ReactNode {
  const label = t(FIELD_LABEL[field]);
  return (
    <Row label={label}>
      <Input
        aria-label={label}
        inputMode="numeric"
        className="w-28 text-right tabular-nums"
        value={form[field]}
        onChange={(e) => onChange({ ...form, [field]: e.target.value.replace(/[^\d]/g, '') })}
      />
    </Row>
  );
}

function PresetField({ label, value, options, onChange }: { label: string; value: ScreenSharePreset; options: ScreenSharePreset[]; onChange: (p: ScreenSharePreset) => void }): ReactNode {
  return (
    <Row label={label}>
      <Select aria-label={label} className="w-44" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((p) => (
          <option key={p} value={p}>
            {t(PRESET_NAME[p])}
          </option>
        ))}
      </Select>
    </Row>
  );
}

export function CustomLimitsFields({ form, onChange }: { form: LimitsForm; onChange: (f: LimitsForm) => void }): ReactNode {
  return (
    <>
      <NumberField field="roomMembers" form={form} onChange={onChange} />
      <NumberField field="streamsPerRoom" form={form} onChange={onChange} />
      <PresetField label={t('admin.limit.streamPreset')} value={form.streamMaxPreset} options={STREAM_PRESETS} onChange={(p) => onChange({ ...form, streamMaxPreset: p })} />
      <NumberField field="streamMaxFps" form={form} onChange={onChange} />
      <PresetField label={t('admin.limit.cameraPreset')} value={form.cameraMaxPreset} options={CAMERA_PRESET_OPTIONS} onChange={(p) => onChange({ ...form, cameraMaxPreset: p })} />
      <NumberField field="cameraMaxFps" form={form} onChange={onChange} />
      <NumberField field="storageMb" form={form} onChange={onChange} />
      <NumberField field="members" form={form} onChange={onChange} />
      <Row label={t('admin.limit.audio')}>
        <Select aria-label={t('admin.limit.audio')} className="w-44" value={form.audioTierMaxKbps} onChange={(e) => onChange({ ...form, audioTierMaxKbps: Number(e.target.value) })}>
          {AUDIO_CAP_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {k === 0 ? t('plan.unlimited') : audioTierLabel(k)}
            </option>
          ))}
        </Select>
      </Row>
      <NumberField field="bots" form={form} onChange={onChange} />
      <NumberField field="stickerPacks" form={form} onChange={onChange} />
      {/* ADR-0058 §5: written with the plan — without them a save would switch both on. */}
      <Row label={t('admin.limit.checklists')} hint={t('admin.limit.checklistsHint')}>
        <Toggle label={t('admin.limit.checklists')} checked={!form.checklistsDisabled} onChange={(v) => onChange({ ...form, checklistsDisabled: !v })} />
      </Row>
      <Row label={t('forms.title')}>
        <Toggle label={t('forms.title')} checked={!form.boardFormsDisabled} onChange={(v) => onChange({ ...form, boardFormsDisabled: !v })} />
      </Row>
      <Row label={t('forms.limit')}>
        <Input aria-label={t('forms.limit')} type="number" min={0} value={form.boardFormsPerBoard} onChange={(e) => onChange({ ...form, boardFormsPerBoard: e.target.value })} />
      </Row>
      <Row label={t('admin.limit.boardWebhooks')} hint={t('admin.limit.boardWebhooksHint')}>
        <Toggle label={t('admin.limit.boardWebhooks')} checked={!form.boardWebhooksDisabled} onChange={(v) => onChange({ ...form, boardWebhooksDisabled: !v })} />
      </Row>
      {/* ADR-0060: board automations (rules and Git) — Team and above; a new Custom plan has them. */}
      <Row label={t('admin.limit.automations')} hint={t('admin.limit.automationsHint')}>
        <Toggle label={t('admin.limit.automations')} checked={!form.automationsDisabled} onChange={(v) => onChange({ ...form, automationsDisabled: !v })} />
      </Row>
      {/* ADR-0046 (owner, 02.10): telephony is Business only; a new Custom plan starts without it. */}
      <Row label={t('admin.limit.telephony')} hint={t('admin.limit.telephonyHint')}>
        <Toggle label={t('admin.limit.telephony')} checked={!form.telephonyDisabled} onChange={(v) => onChange({ ...form, telephonyDisabled: !v })} />
      </Row>
    </>
  );
}
