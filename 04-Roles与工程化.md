# 第 4 篇 · Roles 与工程化（重点篇）

> 单文件 Playbook 能跑通一切，但规模一上来就会失控：几百行 YAML 堆在一起、变量满天飞、无法复用。本篇教你 Ansible 的标准工程化套路：**Role 目录结构 + Jinja2 模板 + 变量分层 + Collections + Vault 加密**。第 5~8 篇的中间件案例都遵循这里的目录约定。

---

## 一、Role：把"部署某个东西"打包

Role 的本质是**按约定目录**拆分的可复用组件："部署 MySQL" 的一切（任务、模板、变量、handler）收进一个 `mysql` 目录，调用者只管 `roles: [mysql]` 并传变量。

### 1.1 标准目录结构

```text
ansible-demo/
├── ansible.cfg
├── inventory.ini
├── site.yml                  # 入口 playbook：声明"哪些机器装哪些角色"
├── group_vars/               # 组变量(自动加载)
│   ├── all.yml               #   所有机器共用的变量
│   └── db.yml                #   db 组的变量
├── host_vars/                # 主机变量(覆盖组变量)
│   └── node2.yml
└── roles/
    └── common/               # 一个角色一个目录
        ├── tasks/main.yml    #   任务清单(必写)
        ├── handlers/main.yml #   触发式任务
        ├── templates/        #   Jinja2 模板(*.j2)
        ├── files/            #   静态文件
        ├── vars/main.yml     #   内部变量(优先级高,不暴露给外部)
        ├── defaults/main.yml #   默认变量(优先级最低,供调用者覆盖)
        ├── meta/main.yml     #   角色元信息(author/版本)
        └── README.md
```

记忆要点：**`defaults` 放"可以被人改的默认值"，`vars` 放"内部固定值"**——外部传同名变量永远能覆盖 defaults，这是 Role 可复用的关键。目录里不用到的子目录可不建。

### 1.2 生成骨架与调用

```bash
cd ~/ansible-demo
ansible-galaxy init roles/common    # 生成标准骨架,删掉用不到的目录即可
```

```yaml
# site.yml —— 入口
- hosts: all
  become: true
  roles:
    - role: common            # 相对路径或 galaxy 上的名字
  # 需要传变量时：
  # - role: mysql
  #   vars: { mysql_root_password: "xxx" }
```

两种进阶调用（想精确控制顺序时用）：

```yaml
tasks:
  - name: 先做系统初始化
    ansible.builtin.import_role:
      name: common
    tags: init
```

## 二、Jinja2 模板：让配置文件"活"起来

模板 = 配置文件 + 变量 + 逻辑，文件后缀习惯用 `.j2`，用 `template` 模块下发。语法全套是 Jinja2（与 Python 模板同源）。

### 2.1 变量与表达式

```jinja
# 普通替换
bind-address = {{ ansible_default_ipv4.address }}
max_connections = {{ mysql_max_connections | default(500) }}

# 表达式与算术
threads = {{ ansible_processor_vcpus * 2 }}
{% if ansible_memtotal_mb >= 4096 %}
innodb_buffer_pool_size = 2G
{% else %}
innodb_buffer_pool_size = 512M
{% endif %}
```

`| default(500)` 给未定义变量兜底——**模板里所有可选变量都应套 default**，否则变量缺失直接报错。

### 2.2 过滤器（最常用 8 个）

| 过滤器 | 作用 | 示例 |
| --- | --- | --- |
| `default(x)` | 未定义时取默认值 | <code v-pre>{{ port \| default(3306) }}</code> |
| `bool` | 字符串转布尔 | <code v-pre>{{ enable_tls \| bool }}</code> |
| `int` / `float` | 类型转换 | <code v-pre>{{ count \| int }}</code> |
| `upper` / `lower` | 大小写 | <code v-pre>{{ hostname \| upper }}</code> |
| `join(分隔符)` | 列表拼字符串 | <code v-pre>{{ servers \| join(',') }}</code>（集群配置神器） |
| `map(attribute=...)` | 提取对象列表的字段 | <code v-pre>{{ nodes \| map(attribute='ip') \| join(',') }}</code> |
| `b64encode` | Base64 | 密码处理 |
| `to_json` / `from_json` | JSON 转换 | 给程序用配置 |

### 2.3 循环与 hostvars（集群场景核心）

```jinja
{# 把组内所有 ES 节点拼成逗号分隔串 —— 第 8 篇 ES 集群就靠它 #}
discovery.seed_hosts: {{ groups['es'] | map('extract', hostvars, 'ansible_default_ipv4') | map(attribute='address') | join(',') }}

{# 逐节点输出配置块 #}
{% for h in groups['zk'] %}
server.{{ loop.index }}={{ hostvars[h]['ansible_default_ipv4'].address }}:2888:3888
{% endfor %}
```

两个魔法变量：`groups['组名']`（组内主机名列表）、`hostvars['主机名']`（任意主机的 facts 与变量）。配合 `inventory_hostname`（当前机器名），"集群互发现"类配置全部可模板化。

## 三、变量分层的完整实践

沿用第 3 篇的优先级规则，工程化的推荐分工：

```text
defaults/main.yml   → 角色默认值(可被覆盖)     lowest
group_vars/all.yml  → 全局变量(apt 镜像源等)
group_vars/db.yml   → db 组变量(mysql 端口等)
host_vars/node2.yml → 单机特殊变量(这台内存大)
playbook vars:      → 站点级固定值
命令行 -e           → 临时覆盖                 highest
```

示例：`roles/mysql/defaults/main.yml`：

```yaml
mysql_port: 3306
mysql_bind_address: "0.0.0.0"
mysql_databases: []            # 调用者可传 [{name: app, encoding: utf8mb4}]
mysql_users: []
```

调用者只需在 `group_vars/db.yml` 里覆盖：

```yaml
mysql_databases:
  - { name: order_db, encoding: utf8mb4 }
mysql_users:
  - { name: app, host: "192.168.100.%", password: "{{ vault_app_db_pwd }}", priv: "order_db.*:ALL" }
```

## 四、Collections：安装第三方"零件包"

第 5~8 篇会用 `community.mysql`（MySQL 模块）、`community.general` 等。`pipx install ansible` 已自带大部分社区集合；缺什么装什么：

```bash
ansible-galaxy collection install community.mysql
ansible-galaxy collection list                 # 查看已装集合

# 团队标准化:写 requirements.yml 一起装
cat > requirements.yml <<'EOF'
collections:
  - name: community.mysql
  - name: community.general
EOF
ansible-galaxy collection install -r requirements.yml
```

装好后即可在 playbook 里用全名调用（第 5 篇开始大量出现）：

```yaml
community.mysql.mysql_db: { name: app, state: present }
```

> EE 路线的对应操作：把集合写进 EE 镜像定义或选择包含它们的 `community-ee-base` 镜像——这正是 EE 存在的意义。

## 五、ansible-vault：敏感变量加密

MySQL 密码、SSH 私钥绝不能明文进 Git。Vault 用 AES 加密任意 YAML：

```bash
# 把含密码的变量文件整体加密
ansible-vault create group_vars/db/vault.yml     # 会要求设置 vault 密码
# 文件内容: vault_mysql_root_pwd: "S3cret!"
ansible-vault edit group_vars/db/vault.yml       # 修改(用编辑器解密暂存)
ansible-vault view group_vars/db/vault.yml       # 只看
ansible-vault rekey group_vars/db/vault.yml      # 换 vault 密码

# 也可只加密单个字符串
ansible-vault encrypt_string 'S3cret!' --name vault_mysql_root_pwd
```

使用时的三种姿势：

```bash
ansible-playbook site.yml --ask-vault-pass                    # 交互输 vault 密码
ansible-playbook site.yml --vault-password-file ~/.vault_pass # 密码存文件(权限 600,gitignore)
export ANSIBLE_VAULT_PASSWORD_FILE=~/.vault_pass
```

加密文件在 playbook 里正常 include 即可，Vault 变量在日志中同样被自动打码。

## 六、项目级最佳实践清单

1. **目录即工程**：inventory + group_vars + roles + site.yml 放一个 Git 仓库，配置变更走评审；
2. **幂等自查**：写完先 `--check --diff` 彩排，再连跑两遍，第二遍应几乎全 `ok`；
3. **所有可调参数进 defaults**，模板里可选变量一律 `| default(x)`；
4. **任务全部写 name**，循环加 `loop_control.label`，查询类任务补 `changed_when: false`；
5. **敏感数据 Vault 化**，文件名以 `vault_` 开头是个好习惯；
6. **tags 分层**（install/config/deploy），支持只跑某一步；
7. 依赖集合写 `requirements.yml` 并纳入 Git；团队规模化时升级到 EE 镜像统一环境；
8. 复杂角色的自动化测试可了解 [Molecule](https://molecule.readthedocs.io/)（进阶，本系列不展开）。

## 七、小结

- Role = 约定目录打包任务/模板/变量；`defaults` 给人改，`vars` 留内部；
- Jinja2 三件套：变量与过滤器（`default`/`join`/`map`）、`if/for` 逻辑、`groups`+`hostvars` 集群发现；
- 集合用 `ansible-galaxy collection install` 引入，第三方模块用全名 `community.mysql.xxx` 调用；
- Vault 加密一切敏感信息，运行时带 `--ask-vault-pass`；
- 工程化四个习惯：`--check --diff` 彩排、两遍幂等自查、变量分层、配置进 Git。

从下一篇开始进入实战：用 Playbook 依次部署 MySQL 单机 → 主从读写分离 → ZooKeeper 集群 → Elasticsearch 集群。

---

*导航：[README](README.md) · 上一篇：[03-Playbook核心语法](03-Playbook核心语法.md) · 下一篇：[05-实操案例-单机MySQL](05-实操案例-单机MySQL.md)*
