model
  schema 1.1

type agent

type node
  relations
    define writer: [agent]
    define reader: [agent]

type proposal
  relations
    define approver: [agent]
