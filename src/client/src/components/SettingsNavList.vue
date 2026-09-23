<template>
  <q-list dense class="settings-nav__list">
    <q-item
      v-for="item in navItems"
      :key="item.value"
      clickable
      v-ripple="false"
      :data-tour="`settings-nav-${item.value}`"
      :class="['settings-nav__item', { 'settings-nav__item--active': activeTab === item.value }]"
      @click="emit('select', item.value)"
    >
      <q-item-section avatar class="settings-nav__icon">
        <q-icon :name="item.icon" size="16px" />
      </q-item-section>
      <q-item-section class="settings-nav__label">{{ item.label }}</q-item-section>
    </q-item>
  </q-list>
</template>

<script setup lang="ts">
interface NavItem {
  value: string
  icon: string
  label: string
}

defineProps<{
  navItems: NavItem[]
  activeTab: string
}>()

const emit = defineEmits<{
  select: [value: string]
}>()
</script>

<style lang="scss" scoped>
.settings-nav__list {
  padding: 0;
}

.settings-nav__item {
  border-radius: var(--kobo-radius-sm);
  padding: 6px 12px;
  color: var(--kobo-text-2);
  font-size: 13px;
  font-weight: 500;
  min-height: 30px;
  transition: background-color var(--kobo-duration-micro) var(--kobo-ease-out),
              color var(--kobo-duration-micro) var(--kobo-ease-out);

  &:hover {
    background-color: var(--kobo-hover);
    color: var(--kobo-text);
  }
}

.settings-nav__item--active {
  background-color: var(--kobo-hover);
  color: var(--kobo-text);
  position: relative;

  &::before {
    content: '';
    position: absolute;
    left: -8px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background-color: var(--kobo-accent);
    border-radius: 1px;
  }
}

.settings-nav__icon {
  min-width: 24px;
  color: inherit;
}

.settings-nav__label {
  padding-left: 4px;
}
</style>
