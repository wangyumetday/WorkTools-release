<template>
    <div class="qujian">
        <div class="wrap">
            <n-cascader v-model:value="value" :options="options" placeholder="qujian " expand-trigger="hover"
                :show-path="false" clearable />
            <input type="text" placeholder="公式" />
            <div class="btn">+</div>
        </div>
    </div>
</template>
<script setup>
import { ref } from 'vue'

const props = defineProps({
    field: { type: Object, default: () => ({}) }
})

// 区间底价公式
function getOptions(depth = 3, iterator = 1, prefix = "") {
    const length = 12;
    const options = [];
    for (let i = 1; i <= length; ++i) {
        if (iterator === 1) {
            options.push({
                value: `v-${i}`,
                label: `l-${i}`,
                disabled: i % 5 === 0,
                children: getOptions(depth, iterator + 1, `${String(i)}`)
            });
        } else if (iterator === depth) {
            options.push({
                value: `v-${prefix}-${i}`,
                label: `l-${prefix}-${i}`,
                disabled: i % 5 === 0
            });
        } else {
            options.push({
                value: `v-${prefix}-${i}`,
                label: `l-${prefix}-${i}`,
                disabled: i % 5 === 0,
                children: getOptions(depth, iterator + 1, `${prefix}-${i}`)
            });
        }
    }
    return options;
}
const checkStrategyIsChild = ref(true);
const showPath = ref(true);
const hoverTrigger = ref(false);
const filterable = ref(false);
const value = ref(null);
const options = getOptions();
function handleUpdateValue(value, option) {
    console.log(value, option);
}

</script>
