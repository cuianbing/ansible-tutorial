# Ansible 从零到一 · 运维自动化系列教程

> 面向**纯小白**：不需要任何自动化运维经验，只要会基本的 Linux 命令。从概念讲起，吃透 Playbook 语法与工程化写法，最后落地 **4 个中间件部署实操案例**（单机 MySQL、MySQL 主从读写分离、ZooKeeper 三节点集群、Elasticsearch 三节点集群），每个案例都是完整可执行的 Playbook。

## 目录

| 篇章 | 文件 | 内容 |
| --- | --- | --- |
| 第 1 篇 | [01-初识Ansible.md](01-初识Ansible.md) | 什么是 Ansible、无代理/幂等/声明式三大特性、核心概念全景、执行环境（EE）是什么 |
| 第 2 篇 | [02-安装与连通.md](02-安装与连通.md) | 动手实操：控制节点安装（pipx/WSL2/官方 EE 容器三条路）、SSH 免密、inventory 编写、ad-hoc 命令、ansible.cfg |
| 第 3 篇 | [03-Playbook核心语法.md](03-Playbook核心语法.md) | ★重点：Playbook 结构、常用模块清单、变量与 facts、handlers、when/loop、tags、check mode |
| 第 4 篇 | [04-Roles与工程化.md](04-Roles与工程化.md) | ★重点：Roles 标准结构、Jinja2 模板、collections 安装、ansible-vault、最佳实践清单 |
| 第 5 篇 | [05-实操案例-单机MySQL.md](05-实操案例-单机MySQL.md) | ★实操：一键部署 MySQL 8 单机（配置、建库、建用户、远程访问、验证） |
| 第 6 篇 | [06-实操案例-MySQL主从读写分离.md](06-实操案例-MySQL主从读写分离.md) | ★实操：GTID 主从复制 + 只读从库 + 读写分离架构说明 |
| 第 7 篇 | [07-实操案例-ZooKeeper三节点集群.md](07-实操案例-ZooKeeper三节点集群.md) | ★实操：Java 环境 + ZK 3.9 集群（myid/zoo.cfg/systemd/健康检查） |
| 第 8 篇 | [08-实操案例-Elasticsearch三节点集群.md](08-实操案例-Elasticsearch三节点集群.md) | ★实操：ES 9 三节点集群（apt 源、sysctl、discovery 配置、集群健康验证） |

## 版本约定（教程写作时点：2026 年 11 月）

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| ansible-core | 2.19+（写作时最新 2.21.x） | 2.19 起模板引擎有重大升级，但本教程语法全系列兼容 |
| Ansible 安装方式 | `pipx install ansible`（社区包） | 自带 community.mysql 等常用集合 |
| community.mysql | ≥ 3.10 | 主从复制用 `mysql_replication` 的 `changereplication` 模式与 `primary_*` 参数（旧的 `master_*` 已是别名） |
| MySQL | 8.0（Ubuntu apt 源） | 8.4+ 个别语法差异文中已标注 |
| ZooKeeper | 3.9.7（bin 包） | 当前活跃维护线 |
| Elasticsearch | 9.5.6（可换 8.19.x） | 变量里改版本号即可 |

## 环境约定

- **控制节点**（装 Ansible、执行命令的机器）：Ubuntu 22.04/24.04 或 **Windows 下的 WSL2**（Ansible 不能在 Windows 原生运行，详见第 2 篇）；
- **受管节点**（被部署的服务器）：Ubuntu 22.04/24.04，SSH 可达，有 sudo 权限；
- 实操案例需要的机器数量：MySQL 两篇需要 **2 台**（主 + 从），ZooKeeper 需要 **3 台**，ES 需要 **3 台**——学习环境可分批复用同一批 3~8 台 1C2G 虚拟机/云主机，每篇案例自带 inventory 片段，改 IP 即可运行；
- 示例统一约定：用户 `deploy`、工作目录 `~/ansible-demo/`、IP 段 `192.168.100.0/24`。

## 参考资料与官方资源

- 官方入门指南（执行环境 EE，中文镜像站）：https://docs.ansible.org.cn/projects/ansible/latest/getting_started_ee/index.html
- 官方文档（英文）：https://docs.ansible.com/ansible/latest/
- 模块速查：https://docs.ansible.com/ansible/latest/collections/all_plugins.html
- Galaxy（Role/Collection 仓库）：https://galaxy.ansible.com
- 中文镜像站首页：https://docs.ansible.org.cn

## 学习路线建议

1. **零基础**：第 1 → 2 篇，装好环境 ping 通一台服务器（30 分钟）；
2. **写部署脚本**：精读第 3、4 篇，把日常手工操作改写成 Playbook；
3. **部署中间件**：直接进入第 5~8 篇实操案例，改 IP / 密码变量即可用；
4. 进阶：把第 5~8 篇案例改造成 Roles 结构（第 4 篇方法），接入团队 Git 仓库。
