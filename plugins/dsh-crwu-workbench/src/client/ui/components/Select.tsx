import { createSelect, type SelectClassNames, type SelectCoreProps, type SelectOption } from './select-core.tsx'

export const CRWU_SELECT_CLASSES: SelectClassNames = {
  root: 'crwu-ui-select',
  trigger: 'crwu-ui-select-trigger',
  value: 'crwu-ui-select-value',
  placeholder: 'crwu-ui-select-placeholder',
  chevron: 'crwu-ui-select-chevron',
  list: 'crwu-ui-select-list',
  listOut: 'crwu-ui-select-list-out',
  option: 'crwu-ui-select-option',
  optionActive: 'crwu-ui-select-option-active',
  optionMark: 'crwu-ui-select-option-mark',
  optionMain: 'crwu-ui-select-option-main',
  optionLabel: 'crwu-ui-select-option-label',
  optionHint: 'crwu-ui-select-option-hint',
  optionBadge: 'crwu-ui-select-option-badge',
}

/**
 * Public select-only combobox. Instance ids come from the shared counter, so two mounts that
 * share a business `name` still get distinct listbox/option ids.
 */
export const Select = createSelect({
  classes: CRWU_SELECT_CLASSES,
  idPrefixOf: (_props, instanceId) => `crwu-ui-select-${instanceId}`,
  rootDataKey: 'data-crwu-select',
  stateDataKey: 'data-crwu-select-state',
  optionDataKey: 'data-crwu-option',
  registryKeyOf: (_props, instanceId) => instanceId,
  labelledByOf: (props, valueId) => props.labelId === undefined ? undefined : `${props.labelId} ${valueId}`,
  animateClose: true,
})

export type SelectProps = SelectCoreProps
export type { SelectOption, SelectCoreProps }
