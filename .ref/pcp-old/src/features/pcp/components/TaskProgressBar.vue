<!-- TaskProgressBar.vue -->
<template>
    <div class="task-progress-bar">
        <div class="task-progress-bar__fill" :class="`task-progress-bar__fill--${status}`" :style="{
            transform: `scaleX(${percent / 100})`,
            transformOrigin: 'left center',
        }" />
    </div>
</template>

<script setup>
defineProps({
    percent: {
        type: Number,
        default: 0,
        validator: (v) => v >= 0 && v <= 100,
    },
    status: {
        type: String,
        default: 'wait',
        validator: (v) => ['wait', 'run', 'done', 'fail', 'pause'].includes(v),
    },
})
</script>

<style scoped>
.task-progress-bar {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    right: 0;
    overflow: hidden;
    z-index: 0;
}

.task-progress-bar__fill {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 100%;
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    will-change: transform;
}

/* 状态颜色 - 纯色，不用半透明 */
.task-progress-bar__fill--wait {
    background-color: #f5f5f5;
}

.task-progress-bar__fill--run {
    background-color: #e6f4ff;
}

.task-progress-bar__fill--done {
    background-color: #f6ffed;
}

.task-progress-bar__fill--fail {
    background-color: #fff1f0;
}

.task-progress-bar__fill--pause {
    background-color: #fffbe6;
}

/* 完成/失败增加条纹装饰 */
.task-progress-bar__fill--done {
    background-image: repeating-linear-gradient(45deg,
            transparent,
            transparent 8px,
            rgba(82, 196, 26, 0.08) 8px,
            rgba(82, 196, 26, 0.08) 16px);
}

.task-progress-bar__fill--fail {
    background-image: repeating-linear-gradient(45deg,
            transparent,
            transparent 8px,
            rgba(255, 77, 79, 0.08) 8px,
            rgba(255, 77, 79, 0.08) 16px);
}

/* 运行中的脉冲动画 */
@keyframes progressPulse {

    0%,
    100% {
        opacity: 1;
    }

    50% {
        opacity: 0.7;
    }
}

.task-progress-bar__fill--run {
    animation: progressPulse 1.5s ease-in-out infinite;
}
</style>