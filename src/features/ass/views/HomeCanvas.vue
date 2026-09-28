<!-- ============================================================
     ASS HomeCanvas.vue - 统计代理画布视图（ComfyUI 式）
     整页一个节点：Home.vue 原样挂入，页面内部结构不动
     ============================================================ -->

<template>
  <FeatureCanvas feature-key="ass" :node-defs="nodeDefs" />
</template>

<script setup>
import { markRaw } from 'vue'
import FeatureCanvas from '@/shared/canvas/FeatureCanvas.vue'
import Home from './Home.vue'

const nodeDefs = [
  {
    id: 'main', title: '统计代理',
    x: 60, y: 50, w: 1120, h: 700, minW: 760, minH: 480,
    component: markRaw(Home)
  }
]
</script>