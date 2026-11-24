---
layout: home

hero:
  name: Ansible 从零到一
  text: 运维自动化系列教程
  tagline: 面向纯小白 —— 从概念讲起，吃透 Playbook 语法与工程化写法，落地 4 个中间件部署实操案例
  actions:
    - theme: brand
      text: 开始阅读
      link: /01-初识Ansible
    - theme: alt
      text: 实操案例
      link: /05-实操案例-单机MySQL
    - theme: alt
      text: GitHub
      link: https://github.com/cuianbing/ansible-tutorial

features:
  - icon: 🚀
    title: 零基础入门
    details: 不需要任何自动化运维经验，只要会基本的 Linux 命令，从概念到安装连通一步到位。
    link: /01-初识Ansible
    linkText: 初识 Ansible
  - icon: 📜
    title: Playbook 核心语法
    details: 结构、常用模块、变量与 facts、handlers、when/loop、tags、check mode 全覆盖。
    link: /03-Playbook核心语法
    linkText: 学习语法
  - icon: 🏗️
    title: Roles 与工程化
    details: Roles 标准结构、Jinja2 模板、collections、ansible-vault 与最佳实践清单。
    link: /04-Roles与工程化
    linkText: 工程化写法
  - icon: 🐬
    title: 实操 · MySQL
    details: 一键部署 MySQL 8 单机，以及 GTID 主从复制 + 只读从库 + 读写分离架构。
    link: /05-实操案例-单机MySQL
    linkText: 单机部署
  - icon: 🦒
    title: 实操 · ZooKeeper
    details: Java 环境 + ZK 3.9 三节点集群：myid / zoo.cfg / systemd / 健康检查。
    link: /07-实操案例-ZooKeeper三节点集群
    linkText: ZK 集群
  - icon: 🔍
    title: 实操 · Elasticsearch
    details: ES 9 三节点集群：apt 源、sysctl、discovery 配置与集群健康验证。
    link: /08-实操案例-Elasticsearch三节点集群
    linkText: ES 集群
---
